/*
 * typeGuards.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Provides logic for narrowing types based on conditional
 * expressions. The logic handles both positive ("if") and
 * negative ("else") narrowing cases.
 */

import {
    ArgumentCategory,
    AssignmentExpressionNode,
    ExpressionNode,
    isExpressionNode,
    NameNode,
    ParameterCategory,
    ParseNode,
    ParseNodeType,
} from '../parser/parseNodes';
import { KeywordType, OperatorType } from '../parser/tokenizerTypes';
import { getFileInfo } from './analyzerNodeInfo';
import { populateTypeVarContextBasedOnExpectedType } from './constraintSolver';
import { Declaration, DeclarationType } from './declaration';
import * as ParseTreeUtils from './parseTreeUtils';
import { ScopeType } from './scope';
import { getScopeForNode } from './scopeUtils';
import { Symbol, SymbolFlags } from './symbol';
import { getTypedDictMembersForClass } from './typedDicts';
import { EvaluatorFlags, TypeEvaluator } from './typeEvaluatorTypes';
import {
    ClassType,
    ClassTypeFlags,
    combineTypes,
    FunctionParameter,
    FunctionType,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isInstantiableClass,
    isModule,
    isNever,
    isNoneInstance,
    isNoneTypeClass,
    isOverloadedFunction,
    isSameWithoutLiteralValue,
    isTypeSame,
    isTypeVar,
    maxTypeRecursionCount,
    NoneType,
    OverloadedFunctionType,
    Type,
    TypeBase,
    TypeCategory,
    TypeCondition,
    TypedDictEntry,
    TypeVarType,
    UnknownType,
} from './types';
import {
    addConditionToType,
    applySolvedTypeVars,
    ClassMember,
    computeMroLinearization,
    convertToInstance,
    convertToInstantiable,
    doForEachSubtype,
    getSpecializedTupleType,
    getTypeCondition,
    getTypeVarScopeId,
    isLiteralType,
    isLiteralTypeOrUnion,
    isMaybeDescriptorInstance,
    isProperty,
    isTupleClass,
    isUnboundedTupleClass,
    lookUpClassMember,
    lookUpObjectMember,
    mapSubtypes,
    stripLiteralValue,
    transformPossibleRecursiveTypeAlias,
} from './typeUtils';
import { TypeVarContext } from './typeVarContext';

export type TypeNarrowingCallback = (type: Type) => Type | undefined;

// Given a reference expression and a test expression, returns a callback that
// can be used to narrow the type described by the reference expression.
// If the specified flow node is not associated with the test expression,
// it returns undefined.
export function getTypeNarrowingCallback(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: ExpressionNode,
    isPositiveTest: boolean,
    recursionCount = 0
): TypeNarrowingCallback | undefined {
    if (recursionCount > maxTypeRecursionCount) {
        return undefined;
    }

    recursionCount++;

    if (testExpression.nodeType === ParseNodeType.AssignmentExpression) {
        return getTypeNarrowingCallbackForAssignmentExpression(
            evaluator,
            reference,
            testExpression,
            isPositiveTest,
            recursionCount
        );
    }

    if (testExpression.nodeType === ParseNodeType.BinaryOperation) {
        const isOrIsNotOperator =
            testExpression.operator === OperatorType.Is || testExpression.operator === OperatorType.IsNot;
        const equalsOrNotEqualsOperator =
            testExpression.operator === OperatorType.Equals || testExpression.operator === OperatorType.NotEquals;

        if (isOrIsNotOperator || equalsOrNotEqualsOperator) {
            // Invert the "isPositiveTest" value if this is an "is not" operation.
            const adjIsPositiveTest =
                testExpression.operator === OperatorType.Is || testExpression.operator === OperatorType.Equals
                    ? isPositiveTest
                    : !isPositiveTest;

            // Look for "X is None", "X is not None", "X == None", and "X != None".
            // These are commonly-used patterns used in control flow.
            if (
                testExpression.rightExpression.nodeType === ParseNodeType.Constant &&
                testExpression.rightExpression.constType === KeywordType.None
            ) {
                // Allow the LHS to be either a simple expression or an assignment
                // expression that assigns to a simple name.
                let leftExpression = testExpression.leftExpression;
                if (leftExpression.nodeType === ParseNodeType.AssignmentExpression) {
                    leftExpression = leftExpression.name;
                }

                if (ParseTreeUtils.isMatchingExpression(reference, leftExpression)) {
                    return (type: Type) => {
                        return narrowTypeForIsNone(evaluator, type, adjIsPositiveTest);
                    };
                }

                if (
                    leftExpression.nodeType === ParseNodeType.Index &&
                    ParseTreeUtils.isMatchingExpression(reference, leftExpression.baseExpression) &&
                    leftExpression.items.length === 1 &&
                    !leftExpression.trailingComma &&
                    leftExpression.items[0].argumentCategory === ArgumentCategory.Simple &&
                    !leftExpression.items[0].name &&
                    leftExpression.items[0].valueExpression.nodeType === ParseNodeType.Number &&
                    leftExpression.items[0].valueExpression.isInteger &&
                    !leftExpression.items[0].valueExpression.isImaginary
                ) {
                    const indexValue = leftExpression.items[0].valueExpression.value;
                    if (typeof indexValue === 'number') {
                        return (type: Type) => {
                            return narrowTupleTypeForIsNone(evaluator, type, adjIsPositiveTest, indexValue);
                        };
                    }
                }
            }

            // Look for "type(X) is Y" or "type(X) is not Y".
            if (isOrIsNotOperator && testExpression.leftExpression.nodeType === ParseNodeType.Call) {
                if (
                    testExpression.leftExpression.arguments.length === 1 &&
                    testExpression.leftExpression.arguments[0].argumentCategory === ArgumentCategory.Simple
                ) {
                    const arg0Expr = testExpression.leftExpression.arguments[0].valueExpression;
                    if (ParseTreeUtils.isMatchingExpression(reference, arg0Expr)) {
                        const callType = evaluator.getTypeOfExpression(
                            testExpression.leftExpression.leftExpression,
                            EvaluatorFlags.DoNotSpecialize
                        ).type;

                        if (isInstantiableClass(callType) && ClassType.isBuiltIn(callType, 'type')) {
                            const classType = evaluator.makeTopLevelTypeVarsConcrete(
                                evaluator.getTypeOfExpression(testExpression.rightExpression).type
                            );

                            if (isInstantiableClass(classType)) {
                                return (type: Type) => {
                                    return narrowTypeForTypeIs(type, classType, adjIsPositiveTest);
                                };
                            }
                        }
                    }
                }
            }

            // Look for "X is Y" or "X is not Y" where Y is a an enum or bool literal.
            if (isOrIsNotOperator) {
                if (ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression)) {
                    const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                    if (
                        isClassInstance(rightType) &&
                        (ClassType.isEnumClass(rightType) || ClassType.isBuiltIn(rightType, 'bool')) &&
                        rightType.literalValue !== undefined
                    ) {
                        return (type: Type) => {
                            return narrowTypeForLiteralComparison(
                                evaluator,
                                type,
                                rightType,
                                adjIsPositiveTest,
                                /* isIsOperator */ true
                            );
                        };
                    }
                }
            }

            if (equalsOrNotEqualsOperator) {
                // Look for X == <literal> or X != <literal>
                const adjIsPositiveTest =
                    testExpression.operator === OperatorType.Equals ? isPositiveTest : !isPositiveTest;

                if (ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression)) {
                    const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                    if (isClassInstance(rightType) && rightType.literalValue !== undefined) {
                        return (type: Type) => {
                            return narrowTypeForLiteralComparison(
                                evaluator,
                                type,
                                rightType,
                                adjIsPositiveTest,
                                /* isIsOperator */ false
                            );
                        };
                    }
                }

                // Look for <literal> == X or <literal> != X
                if (ParseTreeUtils.isMatchingExpression(reference, testExpression.rightExpression)) {
                    const leftType = evaluator.getTypeOfExpression(testExpression.leftExpression).type;
                    if (isClassInstance(leftType) && leftType.literalValue !== undefined) {
                        return (type: Type) => {
                            return narrowTypeForLiteralComparison(
                                evaluator,
                                type,
                                leftType,
                                adjIsPositiveTest,
                                /* isIsOperator */ false
                            );
                        };
                    }
                }

                // Look for X[<literal>] == <literal> or X[<literal>] != <literal>
                if (
                    testExpression.leftExpression.nodeType === ParseNodeType.Index &&
                    testExpression.leftExpression.items.length === 1 &&
                    !testExpression.leftExpression.trailingComma &&
                    testExpression.leftExpression.items[0].argumentCategory === ArgumentCategory.Simple &&
                    ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression.baseExpression)
                ) {
                    const indexType = evaluator.getTypeOfExpression(
                        testExpression.leftExpression.items[0].valueExpression
                    ).type;

                    if (isClassInstance(indexType) && isLiteralType(indexType)) {
                        if (ClassType.isBuiltIn(indexType, 'str')) {
                            const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                            if (isClassInstance(rightType) && rightType.literalValue !== undefined) {
                                return (type: Type) => {
                                    return narrowTypeForDiscriminatedDictEntryComparison(
                                        evaluator,
                                        type,
                                        indexType,
                                        rightType,
                                        adjIsPositiveTest
                                    );
                                };
                            }
                        } else if (ClassType.isBuiltIn(indexType, 'int')) {
                            const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                            if (isClassInstance(rightType) && rightType.literalValue !== undefined) {
                                return (type: Type) => {
                                    return narrowTypeForDiscriminatedTupleComparison(
                                        evaluator,
                                        type,
                                        indexType,
                                        rightType,
                                        adjIsPositiveTest
                                    );
                                };
                            }
                        }
                    }
                }
            }

            // Look for len(x) == <literal> or len(x) != <literal>
            if (
                equalsOrNotEqualsOperator &&
                testExpression.leftExpression.nodeType === ParseNodeType.Call &&
                testExpression.leftExpression.arguments.length === 1 &&
                testExpression.rightExpression.nodeType === ParseNodeType.Number &&
                testExpression.rightExpression.isInteger
            ) {
                const arg0Expr = testExpression.leftExpression.arguments[0].valueExpression;

                if (ParseTreeUtils.isMatchingExpression(reference, arg0Expr)) {
                    const callType = evaluator.getTypeOfExpression(
                        testExpression.leftExpression.leftExpression,
                        EvaluatorFlags.DoNotSpecialize
                    ).type;

                    if (isFunction(callType) && callType.details.fullName === 'builtins.len') {
                        const tupleLength = testExpression.rightExpression.value;

                        if (typeof tupleLength === 'number') {
                            return (type: Type) => {
                                return narrowTypeForTupleLength(evaluator, type, tupleLength, adjIsPositiveTest);
                            };
                        }
                    }
                }
            }

            // Look for X.Y == <literal> or X.Y != <literal>
            if (
                equalsOrNotEqualsOperator &&
                testExpression.leftExpression.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression.leftExpression)
            ) {
                const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                const memberName = testExpression.leftExpression.memberName;
                if (isClassInstance(rightType) && rightType.literalValue !== undefined) {
                    return (type: Type) => {
                        return narrowTypeForDiscriminatedLiteralFieldComparison(
                            evaluator,
                            type,
                            memberName.value,
                            rightType,
                            adjIsPositiveTest
                        );
                    };
                }
            }

            // Look for X.Y is <literal> or X.Y is not <literal> where <literal> is
            // an enum or bool literal
            if (
                testExpression.leftExpression.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression.leftExpression)
            ) {
                const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                const memberName = testExpression.leftExpression.memberName;
                if (
                    isClassInstance(rightType) &&
                    (ClassType.isEnumClass(rightType) || ClassType.isBuiltIn(rightType, 'bool')) &&
                    rightType.literalValue !== undefined
                ) {
                    return (type: Type) => {
                        return narrowTypeForDiscriminatedLiteralFieldComparison(
                            evaluator,
                            type,
                            memberName.value,
                            rightType,
                            adjIsPositiveTest
                        );
                    };
                }
            }

            // Look for X.Y is None or X.Y is not None
            // These are commonly-used patterns used in control flow.
            if (
                testExpression.leftExpression.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression.leftExpression) &&
                testExpression.rightExpression.nodeType === ParseNodeType.Constant &&
                testExpression.rightExpression.constType === KeywordType.None
            ) {
                const memberName = testExpression.leftExpression.memberName;
                return (type: Type) => {
                    return narrowTypeForDiscriminatedFieldNoneComparison(
                        evaluator,
                        type,
                        memberName.value,
                        adjIsPositiveTest
                    );
                };
            }
        }

        if (testExpression.operator === OperatorType.In || testExpression.operator === OperatorType.NotIn) {
            // Look for "x in y" or "x not in y" where y is one of several built-in types.
            if (ParseTreeUtils.isMatchingExpression(reference, testExpression.leftExpression)) {
                const rightType = evaluator.getTypeOfExpression(testExpression.rightExpression).type;
                const adjIsPositiveTest =
                    testExpression.operator === OperatorType.In ? isPositiveTest : !isPositiveTest;

                if (adjIsPositiveTest) {
                    return (type: Type) => {
                        return narrowTypeForContainerType(evaluator, type, rightType);
                    };
                }
            }

            if (ParseTreeUtils.isMatchingExpression(reference, testExpression.rightExpression)) {
                // Look for <string literal> in y where y is a union that contains
                // one or more TypedDicts.
                const leftType = evaluator.getTypeOfExpression(testExpression.leftExpression).type;
                if (isClassInstance(leftType) && ClassType.isBuiltIn(leftType, 'str') && isLiteralType(leftType)) {
                    const adjIsPositiveTest =
                        testExpression.operator === OperatorType.In ? isPositiveTest : !isPositiveTest;
                    return (type: Type) => {
                        return narrowTypeForTypedDictKey(
                            evaluator,
                            type,
                            ClassType.cloneAsInstantiable(leftType),
                            adjIsPositiveTest
                        );
                    };
                }
            }
        }
    }

    if (testExpression.nodeType === ParseNodeType.Call) {
        // Look for "isinstance(X, Y)" or "issubclass(X, Y)".
        if (testExpression.arguments.length === 2) {
            // Make sure the first parameter is a supported expression type
            // and the second parameter is a valid class type or a tuple
            // of valid class types.
            const arg0Expr = testExpression.arguments[0].valueExpression;
            const arg1Expr = testExpression.arguments[1].valueExpression;
            if (ParseTreeUtils.isMatchingExpression(reference, arg0Expr)) {
                const callType = evaluator.getTypeOfExpression(
                    testExpression.leftExpression,
                    EvaluatorFlags.DoNotSpecialize
                ).type;

                if (
                    isFunction(callType) &&
                    (callType.details.builtInName === 'isinstance' || callType.details.builtInName === 'issubclass')
                ) {
                    const isInstanceCheck = callType.details.builtInName === 'isinstance';
                    const arg1Type = evaluator.getTypeOfExpression(
                        arg1Expr,
                        EvaluatorFlags.EvaluateStringLiteralAsType |
                            EvaluatorFlags.ParamSpecDisallowed |
                            EvaluatorFlags.TypeVarTupleDisallowed
                    ).type;

                    const classTypeList = getIsInstanceClassTypes(arg1Type);

                    if (classTypeList) {
                        return (type: Type) => {
                            const narrowedType = narrowTypeForIsInstance(
                                evaluator,
                                type,
                                classTypeList,
                                isInstanceCheck,
                                isPositiveTest,
                                /* allowIntersections */ false,
                                testExpression
                            );
                            if (!isNever(narrowedType)) {
                                return narrowedType;
                            }

                            // Try again with intersection types allowed.
                            return narrowTypeForIsInstance(
                                evaluator,
                                type,
                                classTypeList,
                                isInstanceCheck,
                                isPositiveTest,
                                /* allowIntersections */ true,
                                testExpression
                            );
                        };
                    }
                }
            }
        }

        // Look for "callable(X)"
        if (testExpression.arguments.length === 1) {
            const arg0Expr = testExpression.arguments[0].valueExpression;
            if (ParseTreeUtils.isMatchingExpression(reference, arg0Expr)) {
                const callType = evaluator.getTypeOfExpression(
                    testExpression.leftExpression,
                    EvaluatorFlags.DoNotSpecialize
                ).type;

                if (isFunction(callType) && callType.details.builtInName === 'callable') {
                    return (type: Type) => {
                        let narrowedType = narrowTypeForCallable(
                            evaluator,
                            type,
                            isPositiveTest,
                            testExpression,
                            /* allowIntersections */ false
                        );
                        if (isPositiveTest && isNever(narrowedType)) {
                            // Try again with intersections allowed.
                            narrowedType = narrowTypeForCallable(
                                evaluator,
                                type,
                                isPositiveTest,
                                testExpression,
                                /* allowIntersections */ true
                            );
                        }

                        return narrowedType;
                    };
                }
            }
        }

        // Look for "bool(X)"
        if (testExpression.arguments.length === 1 && !testExpression.arguments[0].name) {
            if (ParseTreeUtils.isMatchingExpression(reference, testExpression.arguments[0].valueExpression)) {
                const callType = evaluator.getTypeOfExpression(
                    testExpression.leftExpression,
                    EvaluatorFlags.DoNotSpecialize
                ).type;

                if (isInstantiableClass(callType) && ClassType.isBuiltIn(callType, 'bool')) {
                    return (type: Type) => {
                        return narrowTypeForTruthiness(evaluator, type, isPositiveTest);
                    };
                }
            }
        }

        // Look for a TypeGuard function.
        if (testExpression.arguments.length >= 1) {
            const arg0Expr = testExpression.arguments[0].valueExpression;
            if (ParseTreeUtils.isMatchingExpression(reference, arg0Expr)) {
                // Does this look like it's a custom type guard function?
                let isPossiblyTypeGuard = false;

                const isFunctionReturnTypeGuard = (type: FunctionType) => {
                    return (
                        type.details.declaredReturnType &&
                        isClassInstance(type.details.declaredReturnType) &&
                        ClassType.isBuiltIn(type.details.declaredReturnType, ['TypeGuard', 'StrictTypeGuard'])
                    );
                };

                const callType = evaluator.getTypeOfExpression(
                    testExpression.leftExpression,
                    EvaluatorFlags.DoNotSpecialize
                ).type;

                if (isFunction(callType) && isFunctionReturnTypeGuard(callType)) {
                    isPossiblyTypeGuard = true;
                } else if (
                    isOverloadedFunction(callType) &&
                    OverloadedFunctionType.getOverloads(callType).some((o) => isFunctionReturnTypeGuard(o))
                ) {
                    isPossiblyTypeGuard = true;
                }

                if (isPossiblyTypeGuard) {
                    // Evaluate the type guard call expression.
                    const functionReturnType = evaluator.getTypeOfExpression(testExpression).type;
                    if (
                        isClassInstance(functionReturnType) &&
                        ClassType.isBuiltIn(functionReturnType, 'bool') &&
                        functionReturnType.typeGuardType
                    ) {
                        const isStrictTypeGuard = !!functionReturnType.isStrictTypeGuard;
                        const typeGuardType = functionReturnType.typeGuardType;

                        return (type: Type) => {
                            return narrowTypeForUserDefinedTypeGuard(
                                evaluator,
                                type,
                                typeGuardType,
                                isPositiveTest,
                                isStrictTypeGuard
                            );
                        };
                    }
                }
            }
        }
    }

    if (ParseTreeUtils.isMatchingExpression(reference, testExpression)) {
        return (type: Type) => {
            return narrowTypeForTruthiness(evaluator, type, isPositiveTest);
        };
    }

    // Is this a reference to an aliased conditional expression (a local variable
    // that was assigned a value that can inform type narrowing of the reference expression)?
    const narrowingCallback = getTypeNarrowingCallbackForAliasedCondition(
        evaluator,
        reference,
        testExpression,
        isPositiveTest,
        recursionCount
    );
    if (narrowingCallback) {
        return narrowingCallback;
    }

    // We normally won't find a "not" operator here because they are stripped out
    // by the binder when it creates condition flow nodes, but we can find this
    // in the case of local variables type narrowing.
    if (reference.nodeType === ParseNodeType.Name) {
        if (testExpression.nodeType === ParseNodeType.UnaryOperation && testExpression.operator === OperatorType.Not) {
            return getTypeNarrowingCallback(
                evaluator,
                reference,
                testExpression.expression,
                !isPositiveTest,
                recursionCount
            );
        }
    }

    return undefined;
}

function getTypeNarrowingCallbackForAliasedCondition(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: ExpressionNode,
    isPositiveTest: boolean,
    recursionCount: number
) {
    if (
        testExpression.nodeType !== ParseNodeType.Name ||
        reference.nodeType !== ParseNodeType.Name ||
        testExpression === reference
    ) {
        return undefined;
    }

    // Make sure the reference expression is a constant parameter or variable.
    // If the reference expression is modified within the scope multiple times,
    // we need to validate that it is not modified between the test expression
    // evaluation and the conditional check.
    const testExprDecl = getDeclsForLocalVar(evaluator, testExpression, testExpression);
    if (!testExprDecl || testExprDecl.length !== 1 || testExprDecl[0].type !== DeclarationType.Variable) {
        return undefined;
    }

    const referenceDecls = getDeclsForLocalVar(evaluator, reference, testExpression);
    if (!referenceDecls) {
        return undefined;
    }

    let modifyingDecls: Declaration[] = [];
    if (referenceDecls.length > 1) {
        // If there is more than one assignment to the reference variable within
        // the local scope, make sure that none of these assignments are done
        // after the test expression but before the condition check.
        //
        // This is OK:
        //  val = None
        //  is_none = val is None
        //  if is_none: ...
        //
        // This is not OK:
        //  val = None
        //  is_none = val is None
        //  val = 1
        //  if is_none: ...
        modifyingDecls = referenceDecls.filter((decl) => {
            return (
                evaluator.isNodeReachable(testExpression, decl.node) &&
                evaluator.isNodeReachable(decl.node, testExprDecl[0].node)
            );
        });
    }

    if (modifyingDecls.length !== 0) {
        return undefined;
    }

    const initNode = testExprDecl[0].inferredTypeSource;

    if (!initNode || ParseTreeUtils.isNodeContainedWithin(testExpression, initNode) || !isExpressionNode(initNode)) {
        return undefined;
    }

    return getTypeNarrowingCallback(evaluator, reference, initNode, isPositiveTest, recursionCount);
}

// Determines whether the symbol is a local variable or parameter within
// the current scope.
function getDeclsForLocalVar(
    evaluator: TypeEvaluator,
    name: NameNode,
    reachableFrom: ParseNode
): Declaration[] | undefined {
    const scope = getScopeForNode(name);
    if (scope?.type !== ScopeType.Function && scope?.type !== ScopeType.Module) {
        return undefined;
    }

    const symbol = scope.lookUpSymbol(name.value);
    if (!symbol) {
        return undefined;
    }

    const decls = symbol.getDeclarations();
    if (
        decls.length === 0 ||
        decls.some((decl) => decl.type !== DeclarationType.Variable && decl.type !== DeclarationType.Parameter)
    ) {
        return undefined;
    }

    // If there are any assignments within different scopes (e.g. via a "global" or
    // "nonlocal" reference), don't consider it a local variable.
    let prevDeclScope: ParseNode | undefined;
    if (
        decls.some((decl) => {
            const nodeToConsider = decl.type === DeclarationType.Parameter ? decl.node.name! : decl.node;
            const declScopeNode = ParseTreeUtils.getExecutionScopeNode(nodeToConsider);
            if (prevDeclScope && declScopeNode !== prevDeclScope) {
                return true;
            }
            prevDeclScope = declScopeNode;
            return false;
        })
    ) {
        return undefined;
    }

    const reachableDecls = decls.filter((decl) => evaluator.isNodeReachable(reachableFrom, decl.node));

    return reachableDecls.length > 0 ? reachableDecls : undefined;
}

function getTypeNarrowingCallbackForAssignmentExpression(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: AssignmentExpressionNode,
    isPositiveTest: boolean,
    recursionCount: number
) {
    return (
        getTypeNarrowingCallback(
            evaluator,
            reference,
            testExpression.rightExpression,
            isPositiveTest,
            recursionCount
        ) ?? getTypeNarrowingCallback(evaluator, reference, testExpression.name, isPositiveTest, recursionCount)
    );
}

function narrowTypeForUserDefinedTypeGuard(
    evaluator: TypeEvaluator,
    type: Type,
    typeGuardType: Type,
    isPositiveTest: boolean,
    isStrictTypeGuard: boolean
): Type {
    // For non-strict type guards, always narrow to the typeGuardType
    // in the positive case and don't narrow in the negative case.
    if (!isStrictTypeGuard) {
        return isPositiveTest ? typeGuardType : type;
    }

    // For strict type guards, narrow the current type.
    return mapSubtypes(type, (subtype) => {
        return mapSubtypes(typeGuardType, (typeGuardSubtype) => {
            const isSubType = evaluator.assignType(typeGuardType, subtype);
            const isSuperType = evaluator.assignType(subtype, typeGuardSubtype);

            if (isPositiveTest) {
                if (isSubType) {
                    return subtype;
                } else if (isSuperType) {
                    return typeGuardSubtype;
                }
            } else {
                if (!isSubType && !isSubType) {
                    return subtype;
                }
            }

            return undefined;
        });
    });
}

// Narrow the type based on whether the subtype can be true or false.
function narrowTypeForTruthiness(evaluator: TypeEvaluator, type: Type, isPositiveTest: boolean) {
    return mapSubtypes(type, (subtype) => {
        if (isPositiveTest) {
            if (evaluator.canBeTruthy(subtype)) {
                return evaluator.removeFalsinessFromType(subtype);
            }
        } else {
            if (evaluator.canBeFalsy(subtype)) {
                return evaluator.removeTruthinessFromType(subtype);
            }
        }
        return undefined;
    });
}

// Handle type narrowing for expressions of the form "a[I] is None" and "a[I] is not None" where
// I is an integer and a is a union of Tuples (or subtypes thereof) with known lengths and entry types.
function narrowTupleTypeForIsNone(evaluator: TypeEvaluator, type: Type, isPositiveTest: boolean, indexValue: number) {
    return evaluator.mapSubtypesExpandTypeVars(type, /* conditionFilter */ undefined, (subtype) => {
        const tupleType = getSpecializedTupleType(subtype);
        if (!tupleType || isUnboundedTupleClass(tupleType) || !tupleType.tupleTypeArguments) {
            return subtype;
        }

        const tupleLength = tupleType.tupleTypeArguments.length;
        if (indexValue < 0 || indexValue >= tupleLength) {
            return subtype;
        }

        const typeOfEntry = evaluator.makeTopLevelTypeVarsConcrete(tupleType.tupleTypeArguments[indexValue].type);

        if (isPositiveTest) {
            if (!evaluator.assignType(typeOfEntry, NoneType.createInstance())) {
                return undefined;
            }
        } else {
            if (isNoneInstance(typeOfEntry)) {
                return undefined;
            }
        }

        return subtype;
    });
}

// Handle type narrowing for expressions of the form "x is None" and "x is not None".
function narrowTypeForIsNone(evaluator: TypeEvaluator, type: Type, isPositiveTest: boolean) {
    const expandedType = mapSubtypes(type, (subtype) => {
        return transformPossibleRecursiveTypeAlias(subtype);
    });

    return evaluator.mapSubtypesExpandTypeVars(
        expandedType,
        /* conditionFilter */ undefined,
        (subtype, unexpandedSubtype) => {
            if (isAnyOrUnknown(subtype)) {
                // We need to assume that "Any" is always both None and not None,
                // so it matches regardless of whether the test is positive or negative.
                return subtype;
            }

            // If this is a TypeVar that isn't constrained, use the unexpanded
            // TypeVar. For all other cases (including constrained TypeVars),
            // use the expanded subtype.
            const adjustedSubtype =
                isTypeVar(unexpandedSubtype) && unexpandedSubtype.details.constraints.length === 0
                    ? unexpandedSubtype
                    : subtype;

            // See if it's a match for object.
            if (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'object')) {
                return isPositiveTest
                    ? addConditionToType(NoneType.createInstance(), subtype.condition)
                    : adjustedSubtype;
            }

            // See if it's a match for None.
            if (isNoneInstance(subtype) === isPositiveTest) {
                return subtype;
            }

            return undefined;
        }
    );
}

// The "isinstance" and "issubclass" calls support two forms - a simple form
// that accepts a single class, and a more complex form that accepts a tuple
// of classes (including arbitrarily-nested tuples). This method determines
// which form and returns a list of classes or undefined.
function getIsInstanceClassTypes(argType: Type): (ClassType | TypeVarType | NoneType | FunctionType)[] | undefined {
    let foundNonClassType = false;
    const classTypeList: (ClassType | TypeVarType | NoneType | FunctionType)[] = [];

    // Create a helper function that returns a list of class types or
    // undefined if any of the types are not valid.
    const addClassTypesToList = (types: Type[]) => {
        types.forEach((subtype) => {
            if (isInstantiableClass(subtype) || (isTypeVar(subtype) && TypeBase.isInstantiable(subtype))) {
                classTypeList.push(subtype);
            } else if (isNoneTypeClass(subtype)) {
                classTypeList.push(subtype);
            } else if (
                isFunction(subtype) &&
                subtype.details.parameters.length === 2 &&
                subtype.details.parameters[0].category === ParameterCategory.VarArgList &&
                subtype.details.parameters[1].category === ParameterCategory.VarArgDictionary
            ) {
                classTypeList.push(subtype);
            } else {
                foundNonClassType = true;
            }
        });
    };

    const addClassTypesRecursive = (subtype: Type, recursionCount = 0) => {
        if (recursionCount > maxTypeRecursionCount) {
            return;
        }

        if (isClass(subtype) && TypeBase.isInstance(subtype) && isTupleClass(subtype)) {
            if (subtype.tupleTypeArguments) {
                subtype.tupleTypeArguments.forEach((tupleEntry) => {
                    addClassTypesRecursive(tupleEntry.type, recursionCount + 1);
                });
            }
        } else {
            addClassTypesToList([subtype]);
        }
    };

    doForEachSubtype(argType, (subtype) => {
        addClassTypesRecursive(subtype);
    });

    return foundNonClassType ? undefined : classTypeList;
}

export function isIsinstanceFilterSuperclass(
    evaluator: TypeEvaluator,
    varType: ClassType,
    filterType: Type,
    concreteFilterType: ClassType,
    isInstanceCheck: boolean
) {
    // If the filter type represents all possible subclasses
    // of a type, we can't make any statements about its superclass
    // relationship with varType.
    if (concreteFilterType.includeSubclasses) {
        return false;
    }

    if (isTypeVar(filterType)) {
        return false;
    }

    if (ClassType.isDerivedFrom(varType, concreteFilterType)) {
        return true;
    }

    if (isInstanceCheck) {
        if (ClassType.isProtocolClass(concreteFilterType) && evaluator.assignType(concreteFilterType, varType)) {
            return true;
        }
    }

    // Handle the special case where the variable type is a TypedDict and
    // we're filtering against 'dict'. TypedDict isn't derived from dict,
    // but at runtime, isinstance returns True.
    if (ClassType.isBuiltIn(concreteFilterType, 'dict') && ClassType.isTypedDictClass(varType)) {
        return true;
    }

    return false;
}

export function isIsinstanceFilterSubclass(
    evaluator: TypeEvaluator,
    varType: ClassType,
    filterType: Type,
    concreteFilterType: ClassType,
    isInstanceCheck: boolean
) {
    if (ClassType.isDerivedFrom(concreteFilterType, varType)) {
        return true;
    }

    if (isInstanceCheck) {
        if (ClassType.isProtocolClass(varType) && evaluator.assignType(varType, concreteFilterType)) {
            return true;
        }
    }

    return false;
}

// Attempts to narrow a type (make it more constrained) based on a
// call to isinstance or issubclass. For example, if the original
// type of expression "x" is "Mammal" and the test expression is
// "isinstance(x, Cow)", (assuming "Cow" is a subclass of "Mammal"),
// we can conclude that x must be constrained to "Cow".
function narrowTypeForIsInstance(
    evaluator: TypeEvaluator,
    type: Type,
    classTypeList: (ClassType | TypeVarType | NoneType | FunctionType)[],
    isInstanceCheck: boolean,
    isPositiveTest: boolean,
    allowIntersections: boolean,
    errorNode: ExpressionNode
): Type {
    const expandedTypes = mapSubtypes(type, (subtype) => {
        return transformPossibleRecursiveTypeAlias(subtype);
    });

    // Filters the varType by the parameters of the isinstance
    // and returns the list of types the varType could be after
    // applying the filter.
    const filterClassType = (
        varType: ClassType,
        unexpandedType: Type,
        constraints: TypeCondition[] | undefined,
        negativeFallbackType: Type
    ): Type[] => {
        const filteredTypes: Type[] = [];

        let foundSuperclass = false;
        let isClassRelationshipIndeterminate = false;

        for (const filterType of classTypeList) {
            const concreteFilterType = evaluator.makeTopLevelTypeVarsConcrete(filterType);

            if (isInstantiableClass(concreteFilterType)) {
                const filterIsSuperclass = isIsinstanceFilterSuperclass(
                    evaluator,
                    varType,
                    filterType,
                    concreteFilterType,
                    isInstanceCheck
                );
                const filterIsSubclass = isIsinstanceFilterSubclass(
                    evaluator,
                    varType,
                    filterType,
                    concreteFilterType,
                    isInstanceCheck
                );

                if (filterIsSuperclass) {
                    foundSuperclass = true;
                }

                // Normally, a type should never be both a subclass or a superclass.
                // This can happen if either of the class types derives from a
                // class whose type is unknown (e.g. an import failed). We'll
                // note this case specially so we don't do any narrowing, which
                // will generate false positives.
                if (
                    filterIsSubclass &&
                    filterIsSuperclass &&
                    !ClassType.isSameGenericClass(varType, concreteFilterType)
                ) {
                    isClassRelationshipIndeterminate = true;
                }

                if (isPositiveTest) {
                    if (filterIsSuperclass) {
                        // If the variable type is a subclass of the isinstance filter,
                        // we haven't learned anything new about the variable type.
                        filteredTypes.push(addConditionToType(varType, constraints));
                    } else if (filterIsSubclass) {
                        // If the variable type is a superclass of the isinstance
                        // filter, we can narrow the type to the subclass.
                        let specializedFilterType = filterType;

                        // Try to retain the type arguments for the filter type. This is
                        // important because a specialized version of the filter cannot
                        // be passed to isinstance or issubclass.
                        if (isClass(filterType)) {
                            if (
                                ClassType.isSpecialBuiltIn(filterType) ||
                                filterType.details.typeParameters.length > 0
                            ) {
                                const typeVarContext = new TypeVarContext(getTypeVarScopeId(filterType));
                                const unspecializedFilterType = ClassType.cloneForSpecialization(
                                    filterType,
                                    /* typeArguments */ undefined,
                                    /* isTypeArgumentExplicit */ false
                                );

                                if (
                                    populateTypeVarContextBasedOnExpectedType(
                                        evaluator,
                                        unspecializedFilterType,
                                        varType,
                                        typeVarContext,
                                        /* liveTypeVarScopes */ undefined
                                    )
                                ) {
                                    specializedFilterType = applySolvedTypeVars(
                                        unspecializedFilterType,
                                        typeVarContext,
                                        /* unknownIfNotFound */ true
                                    ) as ClassType;
                                }
                            }
                        }

                        filteredTypes.push(addConditionToType(specializedFilterType, constraints));
                    } else if (allowIntersections) {
                        // The two types appear to have no relation. It's possible that the
                        // two types are protocols or the program is expecting one type to
                        // be a mix-in class used with the other. In this case, we'll
                        // synthesize a new class type that represents an intersection of
                        // the two types.
                        const className = `<subclass of ${varType.details.name} and ${concreteFilterType.details.name}>`;
                        const fileInfo = getFileInfo(errorNode);
                        let newClassType = ClassType.createInstantiable(
                            className,
                            ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
                            fileInfo.moduleName,
                            fileInfo.filePath,
                            ClassTypeFlags.None,
                            ParseTreeUtils.getTypeSourceId(errorNode),
                            /* declaredMetaclass */ undefined,
                            varType.details.effectiveMetaclass,
                            varType.details.docString
                        );
                        newClassType.details.baseClasses = [ClassType.cloneAsInstantiable(varType), concreteFilterType];
                        computeMroLinearization(newClassType);

                        newClassType = addConditionToType(newClassType, concreteFilterType.condition) as ClassType;

                        if (
                            isTypeVar(unexpandedType) &&
                            !unexpandedType.details.isParamSpec &&
                            unexpandedType.details.constraints.length === 0
                        ) {
                            newClassType = addConditionToType(newClassType, [
                                {
                                    typeVarName: TypeVarType.getNameWithScope(unexpandedType),
                                    constraintIndex: 0,
                                    isConstrainedTypeVar: false,
                                },
                            ]) as ClassType;
                        }

                        const newClassInstanceType = ClassType.cloneAsInstance(newClassType);

                        // If this is a issubclass check, we do a double conversion from instantiable
                        // to instance back to instantiable to make sure that the includeSubclasses flag
                        // gets cleared.
                        filteredTypes.push(
                            isInstanceCheck ? newClassInstanceType : ClassType.cloneAsInstantiable(newClassInstanceType)
                        );
                    }
                }
            } else if (isTypeVar(filterType) && TypeBase.isInstantiable(filterType)) {
                // Handle the case where the filter type is Type[T] and the unexpanded
                // subtype is some instance type, possibly T.
                if (isInstanceCheck && TypeBase.isInstance(unexpandedType)) {
                    if (isTypeVar(unexpandedType) && isTypeSame(convertToInstance(filterType), unexpandedType)) {
                        // If the unexpanded subtype is T, we can definitively filter
                        // in both the positive and negative cases.
                        if (isPositiveTest) {
                            filteredTypes.push(unexpandedType);
                        }
                    } else {
                        if (isPositiveTest) {
                            filteredTypes.push(convertToInstance(filterType));
                        } else {
                            // If the unexpanded subtype is some other instance, we can't
                            // filter anything because it might be an instance.
                            filteredTypes.push(unexpandedType);
                            isClassRelationshipIndeterminate = true;
                        }
                    }
                } else if (!isInstanceCheck && TypeBase.isInstantiable(unexpandedType)) {
                    if (isTypeVar(unexpandedType) && isTypeSame(filterType, unexpandedType)) {
                        if (isPositiveTest) {
                            filteredTypes.push(unexpandedType);
                        }
                    } else {
                        if (isPositiveTest) {
                            filteredTypes.push(filterType);
                        } else {
                            filteredTypes.push(unexpandedType);
                            isClassRelationshipIndeterminate = true;
                        }
                    }
                }
            } else if (isFunction(filterType)) {
                // Handle an isinstance check against Callable.
                if (isInstanceCheck) {
                    let isCallable = false;

                    if (isClass(varType)) {
                        if (TypeBase.isInstantiable(unexpandedType)) {
                            isCallable = true;
                        } else {
                            isCallable = !!lookUpClassMember(varType, '__call__');
                        }
                    }

                    if (isCallable) {
                        if (isPositiveTest) {
                            filteredTypes.push(unexpandedType);
                        } else {
                            foundSuperclass = true;
                        }
                    }
                }
            }
        }

        // In the negative case, if one or more of the filters
        // always match the type (i.e. they are an exact match or
        // a superclass of the type), then there's nothing left after
        // the filter is applied. If we didn't find any superclass
        // match, then the original variable type survives the filter.
        if (!isPositiveTest) {
            if (!foundSuperclass || isClassRelationshipIndeterminate) {
                filteredTypes.push(negativeFallbackType);
            }
        }

        if (!isInstanceCheck) {
            // We perform a double conversion from instance to instantiable
            // here to make sure that the includeSubclasses flag is cleared
            // if it's a class.
            return filteredTypes.map((t) => (isInstantiableClass(t) ? convertToInstantiable(convertToInstance(t)) : t));
        }

        return filteredTypes.map((t) => convertToInstance(t));
    };

    const filterFunctionType = (varType: FunctionType | OverloadedFunctionType, unexpandedType: Type): Type[] => {
        const filteredTypes: Type[] = [];

        if (isPositiveTest) {
            for (const filterType of classTypeList) {
                const concreteFilterType = evaluator.makeTopLevelTypeVarsConcrete(filterType);

                if (evaluator.assignType(varType, convertToInstance(concreteFilterType))) {
                    // If the filter type is a Callable, use the original type. If the
                    // filter type is a callback protocol, use the filter type.
                    if (isFunction(filterType)) {
                        filteredTypes.push(unexpandedType);
                    } else {
                        filteredTypes.push(convertToInstance(filterType));
                    }
                }
            }
        } else if (
            !classTypeList.some((filterType) => {
                // If the filter type is a runtime checkable protocol class, it can
                // be used in an instance check.
                const concreteFilterType = evaluator.makeTopLevelTypeVarsConcrete(filterType);
                if (isClass(concreteFilterType) && !ClassType.isProtocolClass(concreteFilterType)) {
                    return false;
                }

                return evaluator.assignType(varType, convertToInstance(concreteFilterType));
            })
        ) {
            filteredTypes.push(unexpandedType);
        }

        return filteredTypes;
    };

    const anyOrUnknownSubstitutions: Type[] = [];
    const anyOrUnknown: Type[] = [];

    const filteredType = evaluator.mapSubtypesExpandTypeVars(
        expandedTypes,
        /* conditionFilter */ undefined,
        (subtype, unexpandedSubtype) => {
            // If we fail to filter anything in the negative case, we need to decide
            // whether to retain the original TypeVar or replace it with its specialized
            // type(s). We'll assume that if someone is using isinstance or issubclass
            // on a constrained TypeVar that they want to filter based on its constrained
            // parts.
            const negativeFallback = getTypeCondition(subtype) ? subtype : unexpandedSubtype;
            const isSubtypeTypeObject = isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'type');

            if (isPositiveTest && isAnyOrUnknown(subtype)) {
                // If this is a positive test and the effective type is Any or
                // Unknown, we can assume that the type matches one of the
                // specified types.
                if (isInstanceCheck) {
                    anyOrUnknownSubstitutions.push(
                        combineTypes(classTypeList.map((classType) => convertToInstance(classType)))
                    );
                } else {
                    // We perform a double conversion from instance to instantiable
                    // here to make sure that the includeSubclasses flag is cleared
                    // if it's a class.
                    anyOrUnknownSubstitutions.push(
                        combineTypes(
                            classTypeList.map((classType) => convertToInstantiable(convertToInstance(classType)))
                        )
                    );
                }

                anyOrUnknown.push(subtype);
                return undefined;
            }

            if (isInstanceCheck) {
                if (isNoneInstance(subtype)) {
                    const containsNoneType = classTypeList.some((t) => isNoneTypeClass(t));
                    if (isPositiveTest) {
                        return containsNoneType ? subtype : undefined;
                    } else {
                        return containsNoneType ? undefined : subtype;
                    }
                }

                if (isModule(subtype) || (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'ModuleType'))) {
                    // Handle type narrowing for runtime-checkable protocols
                    // when applied to modules.
                    if (isPositiveTest) {
                        const filteredTypes = classTypeList.filter((classType) => {
                            const concreteClassType = evaluator.makeTopLevelTypeVarsConcrete(classType);
                            return (
                                isInstantiableClass(concreteClassType) && ClassType.isProtocolClass(concreteClassType)
                            );
                        });

                        if (filteredTypes.length > 0) {
                            return convertToInstance(combineTypes(filteredTypes));
                        }
                    }
                }

                if (isClassInstance(subtype) && !isSubtypeTypeObject) {
                    return combineTypes(
                        filterClassType(
                            ClassType.cloneAsInstantiable(subtype),
                            convertToInstance(unexpandedSubtype),
                            getTypeCondition(subtype),
                            negativeFallback
                        )
                    );
                }

                if ((isFunction(subtype) || isOverloadedFunction(subtype)) && isInstanceCheck) {
                    return combineTypes(filterFunctionType(subtype, convertToInstance(unexpandedSubtype)));
                }

                if (isInstantiableClass(subtype) || isSubtypeTypeObject) {
                    // Handle the special case of isinstance(x, type).
                    const includesTypeType = classTypeList.some(
                        (classType) => isInstantiableClass(classType) && ClassType.isBuiltIn(classType, 'type')
                    );
                    if (isPositiveTest) {
                        return includesTypeType ? negativeFallback : undefined;
                    } else {
                        return includesTypeType ? undefined : negativeFallback;
                    }
                }
            } else {
                if (isInstantiableClass(subtype)) {
                    return combineTypes(
                        filterClassType(subtype, unexpandedSubtype, getTypeCondition(subtype), negativeFallback)
                    );
                }

                if (isSubtypeTypeObject) {
                    const objectType = evaluator.getBuiltInObject(errorNode, 'object');
                    if (objectType && isClassInstance(objectType)) {
                        return combineTypes(
                            filterClassType(
                                ClassType.cloneAsInstantiable(objectType),
                                convertToInstantiable(unexpandedSubtype),
                                getTypeCondition(subtype),
                                negativeFallback
                            )
                        );
                    }
                }
            }

            return isPositiveTest ? undefined : negativeFallback;
        }
    );

    // If the result is Any/Unknown and contains no other subtypes and
    // we have substitutions for Any/Unknown, use those instead. We don't
    // want to apply this if the filtering produced something other than
    // Any/Unknown. For example, if the statement is "isinstance(x, list)"
    // and the type of x is "List[str] | int | Any", the result should be
    // "List[str]", not "List[str] | List[Unknown]".
    if (isNever(filteredType) && anyOrUnknownSubstitutions.length > 0) {
        return combineTypes(anyOrUnknownSubstitutions);
    }

    if (anyOrUnknown.length > 0) {
        return combineTypes([filteredType, ...anyOrUnknown]);
    }

    return filteredType;
}

// Attempts to narrow a union of tuples based on their known length.
function narrowTypeForTupleLength(
    evaluator: TypeEvaluator,
    referenceType: Type,
    lengthValue: number,
    isPositiveTest: boolean
) {
    return mapSubtypes(referenceType, (subtype) => {
        const concreteSubtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

        // If it's not a tuple, we can't narrow it.
        if (
            !isClassInstance(concreteSubtype) ||
            !isTupleClass(concreteSubtype) ||
            isUnboundedTupleClass(concreteSubtype) ||
            !concreteSubtype.tupleTypeArguments
        ) {
            return subtype;
        }

        const tupleLengthMatches = concreteSubtype.tupleTypeArguments.length === lengthValue;
        return tupleLengthMatches === isPositiveTest ? subtype : undefined;
    });
}

// Attempts to narrow a type (make it more constrained) based on an "in" binary operator.
function narrowTypeForContainerType(evaluator: TypeEvaluator, referenceType: Type, containerType: Type) {
    const elementType = getElementTypeForContainerNarrowing(containerType);
    if (!elementType) {
        return referenceType;
    }

    return narrowTypeForContainerElementType(evaluator, referenceType, elementType);
}

export function getElementTypeForContainerNarrowing(containerType: Type) {
    // We support contains narrowing only for certain built-in types that have been specialized.
    const supportedContainers = ['list', 'set', 'frozenset', 'deque', 'tuple', 'dict', 'defaultdict', 'OrderedDict'];
    if (!isClassInstance(containerType) || !ClassType.isBuiltIn(containerType, supportedContainers)) {
        return undefined;
    }

    if (!containerType.typeArguments || containerType.typeArguments.length < 1) {
        return undefined;
    }

    let elementType = containerType.typeArguments[0];
    if (isTupleClass(containerType) && containerType.tupleTypeArguments) {
        elementType = combineTypes(containerType.tupleTypeArguments.map((t) => t.type));
    }

    return elementType;
}

export function narrowTypeForContainerElementType(evaluator: TypeEvaluator, referenceType: Type, elementType: Type) {
    let canNarrow = true;
    const elementTypeWithoutLiteral = stripLiteralValue(elementType);

    // Look for cases where one or more of the reference subtypes are
    // supertypes of the element types. For example, if the element type
    // is "int | str" and the reference type is "float | bytes", we can
    // narrow the reference type to "float" because it is a supertype of "int".
    const narrowedSupertypes = mapSubtypes(referenceType, (referenceSubtype) => {
        const concreteReferenceType = evaluator.makeTopLevelTypeVarsConcrete(referenceSubtype);

        if (isAnyOrUnknown(concreteReferenceType)) {
            canNarrow = false;
            return referenceSubtype;
        }

        // Handle "type" specially.
        if (isClassInstance(concreteReferenceType) && ClassType.isBuiltIn(concreteReferenceType, 'type')) {
            canNarrow = false;
            return referenceSubtype;
        }

        if (evaluator.assignType(elementType, concreteReferenceType)) {
            return referenceSubtype;
        }

        if (evaluator.assignType(elementTypeWithoutLiteral, concreteReferenceType)) {
            return mapSubtypes(elementType, (elementSubtype) => {
                if (isClassInstance(elementSubtype) && isSameWithoutLiteralValue(referenceSubtype, elementSubtype)) {
                    return elementSubtype;
                }
                return undefined;
            });
        }

        return undefined;
    });

    // Look for cases where one or more of the reference subtypes are
    // subtypes of the element types. For example, if the element type
    // is "int | str" and the reference type is "object", we can
    // narrow the reference type to "int | str" because they are both
    // subtypes of "object".
    const narrowedSubtypes = mapSubtypes(elementType, (elementSubtype) => {
        const concreteElementType = evaluator.makeTopLevelTypeVarsConcrete(elementSubtype);

        if (isAnyOrUnknown(concreteElementType)) {
            canNarrow = false;
            return referenceType;
        }

        if (evaluator.assignType(referenceType, concreteElementType)) {
            return concreteElementType;
        }

        return undefined;
    });

    return canNarrow ? combineTypes([narrowedSupertypes, narrowedSubtypes]) : referenceType;
}

// Attempts to narrow a type based on whether it is a TypedDict with
// a literal key value.
function narrowTypeForTypedDictKey(
    evaluator: TypeEvaluator,
    referenceType: Type,
    literalKey: ClassType,
    isPositiveTest: boolean
): Type {
    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
            const entries = getTypedDictMembersForClass(evaluator, subtype, /* allowNarrowed */ true);
            const tdEntry = entries.get(literalKey.literalValue as string);

            if (isPositiveTest) {
                if (!tdEntry) {
                    // If the class is final, we can say with certainty that if
                    // the TypedDict doesn't define this entry, it is not this type.
                    // If it's not final, we can't say this because it could be a
                    // subclass of this TypedDict that adds more fields.
                    return ClassType.isFinal(subtype) ? undefined : subtype;
                }

                // If the entry is currently not required and not marked provided, we can mark
                // it as provided after this guard expression confirms it is.
                if (tdEntry.isRequired || tdEntry.isProvided) {
                    return subtype;
                }

                const oldNarrowedEntriesMap = subtype.typedDictNarrowedEntries;
                const newNarrowedEntriesMap = new Map<string, TypedDictEntry>();
                if (oldNarrowedEntriesMap) {
                    // Copy the old entries.
                    oldNarrowedEntriesMap.forEach((value, key) => {
                        newNarrowedEntriesMap.set(key, value);
                    });
                }

                // Add the new entry.
                newNarrowedEntriesMap.set(literalKey.literalValue as string, {
                    valueType: tdEntry.valueType,
                    isRequired: false,
                    isProvided: true,
                });

                // Clone the TypedDict object with the new entries.
                return ClassType.cloneAsInstance(
                    ClassType.cloneForNarrowedTypedDictEntries(
                        ClassType.cloneAsInstantiable(subtype),
                        newNarrowedEntriesMap
                    )
                );
            } else {
                return tdEntry !== undefined && (tdEntry.isRequired || tdEntry.isProvided) ? undefined : subtype;
            }
        }

        return subtype;
    });

    return narrowedType;
}

// Attempts to narrow a TypedDict type based on a comparison (equal or not
// equal) between a discriminating entry type that has a declared literal
// type to a literal value.
function narrowTypeForDiscriminatedDictEntryComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: ClassType,
    isPositiveTest: boolean
): Type {
    let canNarrow = true;

    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
            const symbolMap = getTypedDictMembersForClass(evaluator, subtype);
            const tdEntry = symbolMap.get(indexLiteralType.literalValue as string);

            if (tdEntry && isLiteralTypeOrUnion(tdEntry.valueType)) {
                if (isPositiveTest) {
                    return evaluator.assignType(tdEntry.valueType, literalType) ? subtype : undefined;
                } else {
                    return evaluator.assignType(literalType, tdEntry.valueType) ? undefined : subtype;
                }
            }
        }

        canNarrow = false;
        return subtype;
    });

    return canNarrow ? narrowedType : referenceType;
}

function narrowTypeForDiscriminatedTupleComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: ClassType,
    isPositiveTest: boolean
): Type {
    let canNarrow = true;

    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        if (
            isClassInstance(subtype) &&
            ClassType.isTupleClass(subtype) &&
            !isUnboundedTupleClass(subtype) &&
            typeof indexLiteralType.literalValue === 'number'
        ) {
            const indexValue = indexLiteralType.literalValue;
            if (subtype.tupleTypeArguments && indexValue >= 0 && indexValue < subtype.tupleTypeArguments.length) {
                const tupleEntryType = subtype.tupleTypeArguments[indexValue]?.type;
                if (tupleEntryType && isLiteralTypeOrUnion(tupleEntryType)) {
                    if (isPositiveTest) {
                        return evaluator.assignType(tupleEntryType, literalType) ? subtype : undefined;
                    } else {
                        return evaluator.assignType(literalType, tupleEntryType) ? undefined : subtype;
                    }
                }
            }
        }

        canNarrow = false;
        return subtype;
    });

    return canNarrow ? narrowedType : referenceType;
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared literal type to a
// literal value.
function narrowTypeForDiscriminatedLiteralFieldComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    memberName: string,
    literalType: ClassType,
    isPositiveTest: boolean
): Type {
    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        let memberInfo: ClassMember | undefined;

        if (isClassInstance(subtype)) {
            memberInfo = lookUpObjectMember(subtype, memberName);
        } else if (isInstantiableClass(subtype)) {
            memberInfo = lookUpClassMember(subtype, memberName);
        }

        if (memberInfo && memberInfo.isTypeDeclared) {
            let memberType = evaluator.getTypeOfMember(memberInfo);

            // Handle the case where the field is a property
            // that has a declared literal return type for its getter.
            if (isClassInstance(subtype) && isProperty(memberType)) {
                const getterInfo = lookUpObjectMember(memberType, 'fget');

                if (getterInfo && getterInfo.isTypeDeclared) {
                    const getterType = evaluator.getTypeOfMember(getterInfo);
                    if (isFunction(getterType) && getterType.details.declaredReturnType) {
                        const getterReturnType = FunctionType.getSpecializedReturnType(getterType);
                        if (getterReturnType) {
                            memberType = getterReturnType;
                        }
                    }
                }
            }

            if (isLiteralTypeOrUnion(memberType)) {
                if (isPositiveTest) {
                    return evaluator.assignType(memberType, literalType) ? subtype : undefined;
                } else {
                    return evaluator.assignType(literalType, memberType) ? undefined : subtype;
                }
            }
        }

        return subtype;
    });

    return narrowedType;
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared None type to a
// None.
function narrowTypeForDiscriminatedFieldNoneComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    memberName: string,
    isPositiveTest: boolean
): Type {
    return mapSubtypes(referenceType, (subtype) => {
        let memberInfo: ClassMember | undefined;
        if (isClassInstance(subtype)) {
            memberInfo = lookUpObjectMember(subtype, memberName);
        } else if (isInstantiableClass(subtype)) {
            memberInfo = lookUpClassMember(subtype, memberName);
        }

        if (memberInfo && memberInfo.isTypeDeclared) {
            const memberType = evaluator.makeTopLevelTypeVarsConcrete(evaluator.getTypeOfMember(memberInfo));
            let canNarrow = true;

            if (isPositiveTest) {
                doForEachSubtype(memberType, (memberSubtype) => {
                    memberSubtype = evaluator.makeTopLevelTypeVarsConcrete(memberSubtype);

                    // Don't attempt to narrow if the member is a descriptor or property.
                    if (isProperty(memberSubtype) || isMaybeDescriptorInstance(memberSubtype)) {
                        canNarrow = false;
                    }

                    if (isAnyOrUnknown(memberSubtype) || isNoneInstance(memberSubtype) || isNever(memberSubtype)) {
                        canNarrow = false;
                    }
                });
            } else {
                canNarrow = isNoneInstance(memberType);
            }

            if (canNarrow) {
                return undefined;
            }
        }

        return subtype;
    });
}

// Attempts to narrow a type based on a "type(x) is y" or "type(x) is not y" check.
function narrowTypeForTypeIs(type: Type, classType: ClassType, isPositiveTest: boolean) {
    return mapSubtypes(type, (subtype) => {
        if (isClassInstance(subtype)) {
            const matches = ClassType.isDerivedFrom(classType, ClassType.cloneAsInstantiable(subtype));
            if (isPositiveTest) {
                if (matches) {
                    if (ClassType.isSameGenericClass(subtype, classType)) {
                        return subtype;
                    }
                    return ClassType.cloneAsInstance(classType);
                }
                return undefined;
            } else {
                // If the class if marked final and it matches, then
                // we can eliminate it in the negative case.
                if (matches && ClassType.isFinal(subtype)) {
                    return undefined;
                }

                // We can't eliminate the subtype in the negative
                // case because it could be a subclass of the type,
                // in which case `type(x) is y` would fail.
                return subtype;
            }
        } else if (isNoneInstance(subtype)) {
            return isPositiveTest ? undefined : subtype;
        } else if (isAnyOrUnknown(subtype)) {
            return isPositiveTest ? ClassType.cloneAsInstance(classType) : subtype;
        }

        return subtype;
    });
}

// Attempts to narrow a type (make it more constrained) based on a comparison
// (equal or not equal) to a literal value. It also handles "is" or "is not"
// operators if isIsOperator is true.
function narrowTypeForLiteralComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    literalType: ClassType,
    isPositiveTest: boolean,
    isIsOperator: boolean
): Type {
    return mapSubtypes(referenceType, (subtype) => {
        subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);
        if (isClassInstance(subtype) && ClassType.isSameGenericClass(literalType, subtype)) {
            if (subtype.literalValue !== undefined) {
                const literalValueMatches = ClassType.isLiteralValueSame(subtype, literalType);
                if ((literalValueMatches && !isPositiveTest) || (!literalValueMatches && isPositiveTest)) {
                    return undefined;
                }
                return subtype;
            } else if (isPositiveTest) {
                return literalType;
            } else {
                // If we're able to enumerate all possible literal values
                // (for bool or enum), we can eliminate all others in a negative test.
                const allLiteralTypes = enumerateLiteralsForType(evaluator, subtype);
                if (allLiteralTypes && allLiteralTypes.length > 0) {
                    return combineTypes(
                        allLiteralTypes.filter((type) => !ClassType.isLiteralValueSame(type, literalType))
                    );
                }
            }
        } else if (isPositiveTest) {
            if (isIsOperator || isNoneInstance(subtype)) {
                return undefined;
            }
        }

        return subtype;
    });
}

export function enumerateLiteralsForType(evaluator: TypeEvaluator, type: ClassType): ClassType[] | undefined {
    if (ClassType.isBuiltIn(type, 'bool')) {
        // Booleans have only two types: True and False.
        return [
            ClassType.cloneWithLiteral(type, /* value */ true),
            ClassType.cloneWithLiteral(type, /* value */ false),
        ];
    }

    if (ClassType.isEnumClass(type)) {
        // Enumerate all of the values in this enumeration.
        const enumList: ClassType[] = [];
        const fields = type.details.fields;
        fields.forEach((symbol) => {
            if (!symbol.isIgnoredForProtocolMatch()) {
                const symbolType = evaluator.getEffectiveTypeOfSymbol(symbol);
                if (
                    isClassInstance(symbolType) &&
                    ClassType.isSameGenericClass(type, symbolType) &&
                    symbolType.literalValue !== undefined
                ) {
                    enumList.push(symbolType);
                }
            }
        });

        return enumList;
    }

    return undefined;
}

// Attempts to narrow a type (make it more constrained) based on a
// call to "callable". For example, if the original type of expression "x" is
// Union[Callable[..., Any], Type[int], int], it would remove the "int" because
// it's not callable.
function narrowTypeForCallable(
    evaluator: TypeEvaluator,
    type: Type,
    isPositiveTest: boolean,
    errorNode: ExpressionNode,
    allowIntersections: boolean
): Type {
    return evaluator.mapSubtypesExpandTypeVars(type, /* conditionFilter */ undefined, (subtype) => {
        switch (subtype.category) {
            case TypeCategory.Function:
            case TypeCategory.OverloadedFunction: {
                return isPositiveTest ? subtype : undefined;
            }

            case TypeCategory.None:
            case TypeCategory.Module: {
                return isPositiveTest ? undefined : subtype;
            }

            case TypeCategory.Class: {
                if (TypeBase.isInstantiable(subtype)) {
                    return isPositiveTest ? subtype : undefined;
                }

                // See if the object is callable.
                const callMemberType = lookUpClassMember(subtype, '__call__');
                if (!callMemberType) {
                    if (!isPositiveTest) {
                        return subtype;
                    }

                    if (allowIntersections) {
                        // The type appears to not be callable. It's possible that the
                        // two type is a subclass that is callable. We'll synthesize a
                        // new intersection type.
                        const className = `<callable subtype of ${subtype.details.name}>`;
                        const fileInfo = getFileInfo(errorNode);
                        let newClassType = ClassType.createInstantiable(
                            className,
                            ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
                            fileInfo.moduleName,
                            fileInfo.filePath,
                            ClassTypeFlags.None,
                            ParseTreeUtils.getTypeSourceId(errorNode),
                            /* declaredMetaclass */ undefined,
                            subtype.details.effectiveMetaclass,
                            subtype.details.docString
                        );
                        newClassType.details.baseClasses = [ClassType.cloneAsInstantiable(subtype)];
                        computeMroLinearization(newClassType);

                        newClassType = addConditionToType(newClassType, subtype.condition) as ClassType;

                        // Add a __call__ method to the new class.
                        const callMethod = FunctionType.createSynthesizedInstance('__call__');
                        const selfParam: FunctionParameter = {
                            category: ParameterCategory.Simple,
                            name: 'self',
                            type: ClassType.cloneAsInstance(newClassType),
                            hasDeclaredType: true,
                        };
                        FunctionType.addParameter(callMethod, selfParam);
                        FunctionType.addDefaultParameters(callMethod);
                        callMethod.details.declaredReturnType = UnknownType.create();
                        newClassType.details.fields.set(
                            '__call__',
                            Symbol.createWithType(SymbolFlags.ClassMember, callMethod)
                        );

                        return ClassType.cloneAsInstance(newClassType);
                    }

                    return undefined;
                } else {
                    return isPositiveTest ? subtype : undefined;
                }
            }

            default: {
                // For all other types, we can't determine whether it's
                // callable or not, so we can't eliminate them.
                return subtype;
            }
        }
    });
}
