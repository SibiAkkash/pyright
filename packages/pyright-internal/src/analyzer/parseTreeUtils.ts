/*
 * parseTreeUtils.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Utility routines for traversing a parse tree.
 */

import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { assert, assertNever, fail } from '../common/debug';
import { convertPositionToOffset, convertTextRangeToRange } from '../common/positionUtils';
import { Position, Range } from '../common/textRange';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import {
    ArgumentCategory,
    ArgumentNode,
    AssignmentExpressionNode,
    CallNode,
    ClassNode,
    EvaluationScopeNode,
    ExecutionScopeNode,
    ExpressionNode,
    FunctionNode,
    IndexNode,
    isExpressionNode,
    LambdaNode,
    MemberAccessNode,
    ModuleNode,
    NameNode,
    ParameterCategory,
    ParameterNode,
    ParseNode,
    ParseNodeType,
    StatementListNode,
    StatementNode,
    StringListNode,
    StringNode,
    SuiteNode,
    TypeAnnotationNode,
    TypeParameterScopeNode,
} from '../parser/parseNodes';
import { TokenizerOutput } from '../parser/tokenizer';
import { KeywordType, OperatorType, StringToken, StringTokenFlags, Token, TokenType } from '../parser/tokenizerTypes';
import { getScope } from './analyzerNodeInfo';
import { ParseTreeWalker } from './parseTreeWalker';

export const enum PrintExpressionFlags {
    None = 0,

    // Don't use string literals for forward declarations.
    ForwardDeclarations = 1 << 0,

    // By default, strings are truncated. If this flag
    // is specified, the full original string is used.
    DoNotLimitStringLength = 1 << 1,
}

// Returns the depth of the node as measured from the root
// of the parse tree.
export function getNodeDepth(node: ParseNode): number {
    let depth = 0;
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        depth++;
        curNode = curNode.parent;
    }

    return depth;
}

// Returns the deepest node that contains the specified position.
export function findNodeByPosition(
    node: ParseNode,
    position: Position,
    lines: TextRangeCollection<TextRange>
): ParseNode | undefined {
    const offset = convertPositionToOffset(position, lines);
    if (offset === undefined) {
        return undefined;
    }

    return findNodeByOffset(node, offset);
}

// Returns the deepest node that contains the specified offset.
export function findNodeByOffset(node: ParseNode, offset: number): ParseNode | undefined {
    if (offset < node.start || offset > TextRange.getEnd(node)) {
        return undefined;
    }

    const parseTreeWalker = new ParseTreeWalker();

    // The range is found within this node. See if we can localize it
    // further by checking its children.
    const children = parseTreeWalker.visitNode(node);
    for (const child of children) {
        if (child) {
            const containingChild = findNodeByOffset(child, offset);
            if (containingChild) {
                // For augmented assignments, prefer the dest expression, which is a clone
                // of the left expression but is used to hold the type of the operation result.
                if (node.nodeType === ParseNodeType.AugmentedAssignment && containingChild === node.leftExpression) {
                    return node.destExpression;
                }

                return containingChild;
            }
        }
    }

    return node;
}

export function getClassFullName(classNode: ParseNode, moduleName: string, className: string): string {
    const nameParts: string[] = [className];

    let curNode: ParseNode | undefined = classNode;

    // Walk the parse tree looking for classes.
    while (curNode) {
        curNode = getEnclosingClass(curNode);
        if (curNode) {
            nameParts.push(curNode.name.value);
        }
    }

    nameParts.push(moduleName);

    return nameParts.reverse().join('.');
}

// Create an ID that is based on the location within the file.
// This allows us to disambiguate between different types that
// don't have unique names (those that are not created with class
// declarations).
export function getTypeSourceId(node: ParseNode): number {
    return node.start;
}

export function printArgument(node: ArgumentNode, flags: PrintExpressionFlags) {
    let argStr = '';
    if (node.argumentCategory === ArgumentCategory.UnpackedList) {
        argStr = '*';
    } else if (node.argumentCategory === ArgumentCategory.UnpackedDictionary) {
        argStr = '**';
    }
    if (node.name) {
        argStr += node.name.value + '=';
    }
    argStr += printExpression(node.valueExpression, flags);
    return argStr;
}

export function printExpression(node: ExpressionNode, flags = PrintExpressionFlags.None): string {
    switch (node.nodeType) {
        case ParseNodeType.Name: {
            return node.value;
        }

        case ParseNodeType.MemberAccess: {
            return printExpression(node.leftExpression, flags) + '.' + node.memberName.value;
        }

        case ParseNodeType.Call: {
            return (
                printExpression(node.leftExpression, flags) +
                '(' +
                node.arguments.map((arg) => printArgument(arg, flags)).join(', ') +
                ')'
            );
        }

        case ParseNodeType.Index: {
            return (
                printExpression(node.baseExpression, flags) +
                '[' +
                node.items.map((item) => printArgument(item, flags)).join(', ') +
                (node.trailingComma ? ',' : '') +
                ']'
            );
        }

        case ParseNodeType.UnaryOperation: {
            return printOperator(node.operator) + printExpression(node.expression, flags);
        }

        case ParseNodeType.BinaryOperation: {
            const exprStr =
                printExpression(node.leftExpression, flags) +
                ' ' +
                printOperator(node.operator) +
                ' ' +
                printExpression(node.rightExpression, flags);

            return node.parenthesized ? `(${exprStr})` : exprStr;
        }

        case ParseNodeType.Number: {
            let value = node.value.toString();

            // If it's stored as a bigint, strip off the "n".
            if (value.endsWith('n')) {
                value = value.substring(0, value.length - 1);
            }

            if (node.isImaginary) {
                value += 'j';
            }
            return value;
        }

        case ParseNodeType.StringList: {
            if (flags & PrintExpressionFlags.ForwardDeclarations && node.typeAnnotation) {
                return printExpression(node.typeAnnotation, flags);
            } else {
                return node.strings
                    .map((str) => {
                        return printExpression(str, flags);
                    })
                    .join(' ');
            }
        }

        case ParseNodeType.String: {
            let exprString = '';
            if (node.token.flags & StringTokenFlags.Raw) {
                exprString += 'r';
            }

            if (node.token.flags & StringTokenFlags.Unicode) {
                exprString += 'u';
            }

            if (node.token.flags & StringTokenFlags.Bytes) {
                exprString += 'b';
            }

            if (node.token.flags & StringTokenFlags.Format) {
                exprString += 'f';
            }

            let escapedString = node.token.escapedValue;
            if ((flags & PrintExpressionFlags.DoNotLimitStringLength) === 0) {
                const maxStringLength = 32;
                escapedString = escapedString.substring(0, maxStringLength);
            }

            if (node.token.flags & StringTokenFlags.Triplicate) {
                if (node.token.flags & StringTokenFlags.SingleQuote) {
                    exprString += `'''${escapedString}'''`;
                } else {
                    exprString += `"""${escapedString}"""`;
                }
            } else {
                if (node.token.flags & StringTokenFlags.SingleQuote) {
                    exprString += `'${escapedString}'`;
                } else {
                    exprString += `"${escapedString}"`;
                }
            }

            return exprString;
        }

        case ParseNodeType.Assignment: {
            return printExpression(node.leftExpression, flags) + ' = ' + printExpression(node.rightExpression, flags);
        }

        case ParseNodeType.AssignmentExpression: {
            return printExpression(node.name, flags) + ' := ' + printExpression(node.rightExpression, flags);
        }

        case ParseNodeType.TypeAnnotation: {
            return printExpression(node.valueExpression, flags) + ': ' + printExpression(node.typeAnnotation, flags);
        }

        case ParseNodeType.AugmentedAssignment: {
            return (
                printExpression(node.leftExpression, flags) +
                ' ' +
                printOperator(node.operator) +
                ' ' +
                printExpression(node.rightExpression, flags)
            );
        }

        case ParseNodeType.Await: {
            return 'await ' + printExpression(node.expression, flags);
        }

        case ParseNodeType.Ternary: {
            return (
                printExpression(node.ifExpression, flags) +
                ' if ' +
                printExpression(node.testExpression, flags) +
                ' else ' +
                printExpression(node.elseExpression, flags)
            );
        }

        case ParseNodeType.List: {
            const expressions = node.entries.map((expr) => {
                return printExpression(expr, flags);
            });
            return `[${expressions.join(', ')}]`;
        }

        case ParseNodeType.Unpack: {
            return '*' + printExpression(node.expression, flags);
        }

        case ParseNodeType.Tuple: {
            const expressions = node.expressions.map((expr) => {
                return printExpression(expr, flags);
            });
            if (expressions.length === 1) {
                return `(${expressions[0]}, )`;
            }
            return `(${expressions.join(', ')})`;
        }

        case ParseNodeType.Yield: {
            if (node.expression) {
                return 'yield ' + printExpression(node.expression, flags);
            } else {
                return 'yield';
            }
        }

        case ParseNodeType.YieldFrom: {
            return 'yield from ' + printExpression(node.expression, flags);
        }

        case ParseNodeType.Ellipsis: {
            return '...';
        }

        case ParseNodeType.ListComprehension: {
            let listStr = '<ListExpression>';

            if (isExpressionNode(node.expression)) {
                listStr = printExpression(node.expression as ExpressionNode, flags);
            } else if (node.expression.nodeType === ParseNodeType.DictionaryKeyEntry) {
                const keyStr = printExpression(node.expression.keyExpression, flags);
                const valueStr = printExpression(node.expression.valueExpression, flags);
                listStr = `${keyStr}: ${valueStr}`;
            }

            listStr =
                listStr +
                ' ' +
                node.forIfNodes
                    .map((expr) => {
                        if (expr.nodeType === ParseNodeType.ListComprehensionFor) {
                            return (
                                `${expr.isAsync ? 'async ' : ''}for ` +
                                printExpression(expr.targetExpression, flags) +
                                ` in ${printExpression(expr.iterableExpression, flags)}`
                            );
                        } else {
                            return `if ${printExpression(expr.testExpression, flags)}`;
                        }
                    })
                    .join(' ');

            return node.isParenthesized ? `(${listStr}})` : listStr;
        }

        case ParseNodeType.Slice: {
            let result = '';

            if (node.startValue || node.endValue || node.stepValue) {
                if (node.startValue) {
                    result += printExpression(node.startValue, flags);
                }
                if (node.endValue) {
                    result += ': ' + printExpression(node.endValue, flags);
                }
                if (node.stepValue) {
                    result += ': ' + printExpression(node.stepValue, flags);
                }
            } else {
                result += ':';
            }

            return result;
        }

        case ParseNodeType.Lambda: {
            return (
                'lambda ' +
                node.parameters
                    .map((param) => {
                        let paramStr = '';

                        if (param.category === ParameterCategory.VarArgList) {
                            paramStr += '*';
                        } else if (param.category === ParameterCategory.VarArgDictionary) {
                            paramStr += '**';
                        }

                        if (param.name) {
                            paramStr += param.name.value;
                        } else if (param.category === ParameterCategory.Simple) {
                            paramStr += '/';
                        }

                        if (param.defaultValue) {
                            paramStr += ' = ' + printExpression(param.defaultValue, flags);
                        }
                        return paramStr;
                    })
                    .join(', ') +
                ': ' +
                printExpression(node.expression, flags)
            );
        }

        case ParseNodeType.Constant: {
            if (node.constType === KeywordType.True) {
                return 'True';
            } else if (node.constType === KeywordType.False) {
                return 'False';
            } else if (node.constType === KeywordType.Debug) {
                return '__debug__';
            } else if (node.constType === KeywordType.None) {
                return 'None';
            }
            break;
        }

        case ParseNodeType.Dictionary: {
            const dictContents = `${node.entries.map((entry) => {
                if (entry.nodeType === ParseNodeType.DictionaryKeyEntry) {
                    return (
                        `${printExpression(entry.keyExpression, flags)}: ` +
                        `${printExpression(entry.valueExpression, flags)}`
                    );
                } else if (entry.nodeType === ParseNodeType.DictionaryExpandEntry) {
                    return `**${printExpression(entry.expandExpression, flags)}`;
                } else {
                    return printExpression(entry, flags);
                }
            })}`;

            if (dictContents) {
                return `{ ${dictContents} }`;
            }

            return '{}';
        }

        case ParseNodeType.Set: {
            return node.entries.map((entry) => printExpression(entry, flags)).join(', ');
        }
    }

    return '<Expression>';
}

export function printOperator(operator: OperatorType): string {
    const operatorMap: { [operator: number]: string } = {
        [OperatorType.Add]: '+',
        [OperatorType.AddEqual]: '+=',
        [OperatorType.Assign]: '=',
        [OperatorType.BitwiseAnd]: '&',
        [OperatorType.BitwiseAndEqual]: '&=',
        [OperatorType.BitwiseInvert]: '~',
        [OperatorType.BitwiseOr]: '|',
        [OperatorType.BitwiseOrEqual]: '|=',
        [OperatorType.BitwiseXor]: '^',
        [OperatorType.BitwiseXorEqual]: '^=',
        [OperatorType.Divide]: '/',
        [OperatorType.DivideEqual]: '/=',
        [OperatorType.Equals]: '==',
        [OperatorType.FloorDivide]: '//',
        [OperatorType.FloorDivideEqual]: '//=',
        [OperatorType.GreaterThan]: '>',
        [OperatorType.GreaterThanOrEqual]: '>=',
        [OperatorType.LeftShift]: '<<',
        [OperatorType.LeftShiftEqual]: '<<=',
        [OperatorType.LessOrGreaterThan]: '<>',
        [OperatorType.LessThan]: '<',
        [OperatorType.LessThanOrEqual]: '<=',
        [OperatorType.MatrixMultiply]: '@',
        [OperatorType.MatrixMultiplyEqual]: '@=',
        [OperatorType.Mod]: '%',
        [OperatorType.ModEqual]: '%=',
        [OperatorType.Multiply]: '*',
        [OperatorType.MultiplyEqual]: '*=',
        [OperatorType.NotEquals]: '!=',
        [OperatorType.Power]: '**',
        [OperatorType.PowerEqual]: '**=',
        [OperatorType.RightShift]: '>>',
        [OperatorType.RightShiftEqual]: '>>=',
        [OperatorType.Subtract]: '-',
        [OperatorType.SubtractEqual]: '-=',
        [OperatorType.And]: 'and',
        [OperatorType.Or]: 'or',
        [OperatorType.Not]: 'not',
        [OperatorType.Is]: 'is',
        [OperatorType.IsNot]: 'is not',
        [OperatorType.In]: 'in',
        [OperatorType.NotIn]: 'not in',
    };

    if (operatorMap[operator]) {
        return operatorMap[operator];
    }

    return 'unknown';
}

export function getEnclosingSuite(node: ParseNode): SuiteNode | undefined {
    let curNode = node.parent;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Suite) {
            return curNode;
        }
        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingClass(node: ParseNode, stopAtFunction = false): ClassNode | undefined {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Class) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Module) {
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.Function) {
            if (stopAtFunction) {
                return undefined;
            }
        }

        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingModule(node: ParseNode): ModuleNode {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Module) {
            return curNode;
        }

        curNode = curNode.parent;
    }

    fail('Module node not found');
    return undefined!;
}

export function getEnclosingClassOrModule(node: ParseNode, stopAtFunction = false): ClassNode | ModuleNode | undefined {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Class) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Module) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Function) {
            if (stopAtFunction) {
                return undefined;
            }
        }

        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingFunction(node: ParseNode): FunctionNode | undefined {
    let curNode = node.parent;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Function) {
            // Don't treat a decorator as being "enclosed" in the function.
            if (!curNode.decorators.some((decorator) => decorator === prevNode)) {
                return curNode;
            }
        }

        if (curNode.nodeType === ParseNodeType.Class) {
            return undefined;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingLambda(node: ParseNode): LambdaNode | undefined {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Lambda) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Suite) {
            return undefined;
        }

        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingClassOrFunction(node: ParseNode): FunctionNode | ClassNode | undefined {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Function) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Class) {
            return curNode;
        }

        curNode = curNode.parent;
    }

    return undefined;
}

export function getEnclosingSuiteOrModule(
    node: ParseNode,
    stopAtFunction = false,
    stopAtLambda = true
): SuiteNode | ModuleNode | undefined {
    let curNode = node.parent;
    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Suite) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Module) {
            return curNode;
        }

        if (curNode.nodeType === ParseNodeType.Lambda) {
            if (stopAtLambda) {
                return undefined;
            }
        }

        if (curNode.nodeType === ParseNodeType.Function) {
            if (stopAtFunction) {
                return undefined;
            }
        }

        curNode = curNode.parent;
    }

    return undefined;
}

export function getEvaluationNodeForAssignmentExpression(
    node: AssignmentExpressionNode
): LambdaNode | FunctionNode | ModuleNode | ClassNode | undefined {
    // PEP 572 indicates that the evaluation node for an assignment expression
    // target within a list comprehension is contained within a lambda,
    // function or module, but not a class.
    let sawListComprehension = false;
    let curNode: ParseNode | undefined = getEvaluationScopeNode(node);

    while (curNode !== undefined) {
        switch (curNode.nodeType) {
            case ParseNodeType.Function:
            case ParseNodeType.Lambda:
            case ParseNodeType.Module:
                return curNode;

            case ParseNodeType.Class:
                return sawListComprehension ? undefined : curNode;

            case ParseNodeType.ListComprehension:
                sawListComprehension = true;
                curNode = getEvaluationScopeNode(curNode.parent!);
                break;

            default:
                return undefined;
        }
    }

    return undefined;
}

// Returns the parse node corresponding to the scope that is used to evaluate
// a symbol referenced in the specified node.
export function getEvaluationScopeNode(node: ParseNode): EvaluationScopeNode {
    let prevNode: ParseNode | undefined;
    let prevPrevNode: ParseNode | undefined;
    let curNode: ParseNode | undefined = node;
    let isParamNameNode = false;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Parameter && prevNode === curNode.name) {
            // Note that we passed through a parameter name node.
            isParamNameNode = true;
        }

        // We found a scope associated with this node. In most cases,
        // we'll return this scope, but in a few cases we need to return
        // the enclosing scope instead.
        switch (curNode.nodeType) {
            case ParseNodeType.Function: {
                if (curNode.parameters.some((param) => param === prevNode)) {
                    if (isParamNameNode) {
                        if (getScope(curNode) !== undefined) {
                            return curNode;
                        }
                    }
                } else if (prevNode === curNode.suite) {
                    if (getScope(curNode) !== undefined) {
                        return curNode;
                    }
                }
                break;
            }

            case ParseNodeType.Lambda: {
                if (curNode.parameters.some((param) => param === prevNode)) {
                    if (isParamNameNode) {
                        if (getScope(curNode) !== undefined) {
                            return curNode;
                        }
                    }
                } else if (!prevNode || prevNode === curNode.expression) {
                    if (getScope(curNode) !== undefined) {
                        return curNode;
                    }
                }
                break;
            }

            case ParseNodeType.Class: {
                if (prevNode === curNode.suite) {
                    if (getScope(curNode) !== undefined) {
                        return curNode;
                    }
                }
                break;
            }

            case ParseNodeType.ListComprehension: {
                if (getScope(curNode) !== undefined) {
                    // The iterable expression of the first subnode of a list comprehension
                    // is evaluated within the scope of its parent.
                    const isFirstIterableExpr =
                        prevNode === curNode.forIfNodes[0] &&
                        curNode.forIfNodes[0].nodeType === ParseNodeType.ListComprehensionFor &&
                        curNode.forIfNodes[0].iterableExpression === prevPrevNode;

                    if (!isFirstIterableExpr) {
                        return curNode;
                    }
                }
                break;
            }

            case ParseNodeType.Module: {
                if (getScope(curNode) !== undefined) {
                    return curNode;
                }
                break;
            }
        }

        prevPrevNode = prevNode;
        prevNode = curNode;
        curNode = curNode.parent;
    }

    fail('Did not find evaluation scope');
    return undefined!;
}

// Returns the parse node corresponding to the function, class, or type alias
// that contains the specified typeVar reference.
export function getTypeVarScopeNode(node: ParseNode): TypeParameterScopeNode {
    let prevNode: ParseNode | undefined;
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        switch (curNode.nodeType) {
            case ParseNodeType.Function: {
                if (!curNode.decorators.some((decorator) => decorator === prevNode)) {
                    return curNode;
                }
                break;
            }

            case ParseNodeType.Class: {
                if (!curNode.decorators.some((decorator) => decorator === prevNode)) {
                    return curNode;
                }
                break;
            }

            case ParseNodeType.TypeAlias: {
                return curNode;
            }
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return undefined!;
}

// Returns the parse node corresponding to the scope that is used
// for executing the code referenced in the specified node.
export function getExecutionScopeNode(node: ParseNode): ExecutionScopeNode {
    let evaluationScope = getEvaluationScopeNode(node);

    // Classes are not considered execution scope because they are executed
    // within the context of their containing module or function. Likewise, list
    // comprehensions are executed within their container.
    while (
        evaluationScope.nodeType === ParseNodeType.Class ||
        evaluationScope.nodeType === ParseNodeType.ListComprehension
    ) {
        evaluationScope = getEvaluationScopeNode(evaluationScope.parent!);
    }

    return evaluationScope;
}

// Given a node within a type annotation expression, returns the type annotation
// node that contains it (if applicable).
export function getTypeAnnotationNode(node: ParseNode): TypeAnnotationNode | undefined {
    let prevNode = node;
    let curNode = node.parent;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.TypeAnnotation) {
            if (curNode.typeAnnotation === prevNode) {
                return curNode;
            }

            break;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return undefined;
}

// PEP 591 spells out certain limited cases where an assignment target
// can be annotated with a "Final" annotation. This function determines
// whether Final is allowed for the specified node.
export function isFinalAllowedForAssignmentTarget(targetNode: ExpressionNode): boolean {
    // Simple names always support Final.
    if (targetNode.nodeType === ParseNodeType.Name) {
        return true;
    }

    // Member access expressions like "self.x" are permitted only
    // within __init__ methods.
    if (targetNode.nodeType === ParseNodeType.MemberAccess) {
        if (targetNode.leftExpression.nodeType !== ParseNodeType.Name) {
            return false;
        }

        const classNode = getEnclosingClass(targetNode);
        if (!classNode) {
            return false;
        }

        const methodNode = getEnclosingFunction(targetNode);
        if (!methodNode) {
            return false;
        }

        if (methodNode.name.value !== '__init__') {
            return false;
        }

        return true;
    }

    return false;
}

export function isClassVarAllowedForAssignmentTarget(targetNode: ExpressionNode): boolean {
    const classNode = getEnclosingClass(targetNode, /* stopAtFunction */ true);
    if (!classNode) {
        return false;
    }

    return true;
}

export function isNodeContainedWithin(node: ParseNode, potentialContainer: ParseNode): boolean {
    let curNode: ParseNode | undefined = node;
    while (curNode) {
        if (curNode === potentialContainer) {
            return true;
        }

        curNode = curNode.parent;
    }

    return false;
}

export function getParentNodeOfType(node: ParseNode, containerType: ParseNodeType): ParseNode | undefined {
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        if (curNode.nodeType === containerType) {
            return curNode;
        }

        curNode = curNode.parent;
    }

    return undefined;
}

// If the specified node is contained within an expression that is intended to be
// interpreted as a type annotation, this function returns the annotation node.
export function getParentAnnotationNode(node: ExpressionNode): ExpressionNode | undefined {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Function) {
            if (prevNode === curNode.returnTypeAnnotation) {
                return prevNode;
            }
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.Parameter) {
            if (prevNode === curNode.typeAnnotation || prevNode === curNode.typeAnnotationComment) {
                return prevNode;
            }
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.Assignment) {
            if (prevNode === curNode.typeAnnotationComment) {
                return prevNode;
            }
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.TypeAnnotation) {
            if (prevNode === curNode.typeAnnotation) {
                return prevNode;
            }
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.FunctionAnnotation) {
            if (prevNode === curNode.returnTypeAnnotation || curNode.paramTypeAnnotations.some((p) => p === prevNode)) {
                assert(!prevNode || isExpressionNode(prevNode));
                return prevNode;
            }
            return undefined;
        }

        if (curNode.nodeType === ParseNodeType.StringList) {
            if (prevNode === curNode.typeAnnotation) {
                return prevNode;
            }
            return undefined;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return undefined;
}

export function isNodeContainedWithinNodeType(node: ParseNode, containerType: ParseNodeType): boolean {
    return getParentNodeOfType(node, containerType) !== undefined;
}

export function isSuiteEmpty(node: SuiteNode): boolean {
    let sawEllipsis = false;

    for (const statement of node.statements) {
        if (statement.nodeType === ParseNodeType.StatementList) {
            for (const substatement of statement.statements) {
                if (substatement.nodeType === ParseNodeType.Ellipsis) {
                    // Allow an ellipsis
                    sawEllipsis = true;
                } else if (substatement.nodeType === ParseNodeType.StringList) {
                    // Allow doc strings
                } else {
                    return false;
                }
            }
        } else {
            return false;
        }
    }

    return sawEllipsis;
}

export function isMatchingExpression(reference: ExpressionNode, expression: ExpressionNode): boolean {
    if (reference.nodeType === ParseNodeType.Name) {
        if (expression.nodeType === ParseNodeType.Name) {
            return reference.value === expression.value;
        } else if (expression.nodeType === ParseNodeType.AssignmentExpression) {
            return reference.value === expression.name.value;
        }
        return false;
    } else if (
        reference.nodeType === ParseNodeType.MemberAccess &&
        expression.nodeType === ParseNodeType.MemberAccess
    ) {
        return (
            isMatchingExpression(reference.leftExpression, expression.leftExpression) &&
            reference.memberName.value === expression.memberName.value
        );
    } else if (reference.nodeType === ParseNodeType.Index && expression.nodeType === ParseNodeType.Index) {
        if (!isMatchingExpression(reference.baseExpression, expression.baseExpression)) {
            return false;
        }

        if (
            expression.items.length !== 1 ||
            expression.trailingComma ||
            expression.items[0].name ||
            expression.items[0].argumentCategory !== ArgumentCategory.Simple
        ) {
            return false;
        }

        const expr = reference.items[0].valueExpression;
        if (expr.nodeType === ParseNodeType.Number) {
            const subscriptNode = expression.items[0].valueExpression;
            if (
                subscriptNode.nodeType !== ParseNodeType.Number ||
                subscriptNode.isImaginary ||
                !subscriptNode.isInteger
            ) {
                return false;
            }

            return expr.value === subscriptNode.value;
        }

        if (
            expr.nodeType === ParseNodeType.UnaryOperation &&
            expr.operator === OperatorType.Subtract &&
            expr.expression.nodeType === ParseNodeType.Number
        ) {
            const subscriptNode = expression.items[0].valueExpression;
            if (
                subscriptNode.nodeType !== ParseNodeType.UnaryOperation ||
                subscriptNode.operator !== OperatorType.Subtract ||
                subscriptNode.expression.nodeType !== ParseNodeType.Number ||
                subscriptNode.expression.isImaginary ||
                !subscriptNode.expression.isInteger
            ) {
                return false;
            }

            return expr.expression.value === subscriptNode.expression.value;
        }

        if (expr.nodeType === ParseNodeType.StringList) {
            const referenceStringListNode = expr;
            const subscriptNode = expression.items[0].valueExpression;
            if (
                referenceStringListNode.strings.length === 1 &&
                referenceStringListNode.strings[0].nodeType === ParseNodeType.String &&
                subscriptNode.nodeType === ParseNodeType.StringList &&
                subscriptNode.strings.length === 1 &&
                subscriptNode.strings[0].nodeType === ParseNodeType.String
            ) {
                return referenceStringListNode.strings[0].value === subscriptNode.strings[0].value;
            }
        }

        return false;
    }

    return false;
}

export function isPartialMatchingExpression(reference: ExpressionNode, expression: ExpressionNode): boolean {
    if (reference.nodeType === ParseNodeType.MemberAccess) {
        return (
            isMatchingExpression(reference.leftExpression, expression) ||
            isPartialMatchingExpression(reference.leftExpression, expression)
        );
    } else if (reference.nodeType === ParseNodeType.Index) {
        return (
            isMatchingExpression(reference.baseExpression, expression) ||
            isPartialMatchingExpression(reference.baseExpression, expression)
        );
    }

    return false;
}

export function isWithinDefaultParamInitializer(node: ParseNode) {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Parameter && prevNode === curNode.defaultValue) {
            return true;
        }

        if (
            curNode.nodeType === ParseNodeType.Lambda ||
            curNode.nodeType === ParseNodeType.Function ||
            curNode.nodeType === ParseNodeType.Class ||
            curNode.nodeType === ParseNodeType.Module
        ) {
            return false;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function isWithinTypeAnnotation(node: ParseNode, requireQuotedAnnotation: boolean) {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;
    let isQuoted = false;

    while (curNode) {
        if (
            curNode.nodeType === ParseNodeType.Parameter &&
            (prevNode === curNode.typeAnnotation || prevNode === curNode.typeAnnotationComment)
        ) {
            return isQuoted || !requireQuotedAnnotation;
        }

        if (curNode.nodeType === ParseNodeType.Function && prevNode === curNode.returnTypeAnnotation) {
            return isQuoted || !requireQuotedAnnotation;
        }

        if (curNode.nodeType === ParseNodeType.Function && prevNode === curNode.functionAnnotationComment) {
            // Type comments are always considered forward declarations even though
            // they're not "quoted".
            return true;
        }

        if (curNode.nodeType === ParseNodeType.TypeAnnotation && prevNode === curNode.typeAnnotation) {
            return isQuoted || !requireQuotedAnnotation;
        }

        if (curNode.nodeType === ParseNodeType.Assignment && prevNode === curNode.typeAnnotationComment) {
            // Type comments are always considered forward declarations even though
            // they're not "quoted".
            return true;
        }

        if (curNode.nodeType === ParseNodeType.StringList && prevNode === curNode.typeAnnotation) {
            isQuoted = true;
        }

        if (
            curNode.nodeType === ParseNodeType.Lambda ||
            curNode.nodeType === ParseNodeType.Function ||
            curNode.nodeType === ParseNodeType.Class ||
            curNode.nodeType === ParseNodeType.Module
        ) {
            return false;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function isWithinAnnotationComment(node: ParseNode) {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Function && prevNode === curNode.functionAnnotationComment) {
            // Type comments are always considered forward declarations even though
            // they're not "quoted".
            return true;
        }

        if (curNode.nodeType === ParseNodeType.Assignment && prevNode === curNode.typeAnnotationComment) {
            // Type comments are always considered forward declarations even though
            // they're not "quoted".
            return true;
        }

        if (
            curNode.nodeType === ParseNodeType.Lambda ||
            curNode.nodeType === ParseNodeType.Function ||
            curNode.nodeType === ParseNodeType.Class ||
            curNode.nodeType === ParseNodeType.Module
        ) {
            return false;
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function isWithinLoop(node: ParseNode): boolean {
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        switch (curNode.nodeType) {
            case ParseNodeType.For:
            case ParseNodeType.While: {
                return true;
            }

            case ParseNodeType.Module: {
                break;
            }
        }

        curNode = curNode.parent;
    }

    return false;
}

export function isWithinTryBlock(node: ParseNode, treatWithAsTryBlock = false): boolean {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        switch (curNode.nodeType) {
            case ParseNodeType.Try: {
                return curNode.trySuite === prevNode;
            }

            case ParseNodeType.With: {
                if (treatWithAsTryBlock && curNode.suite === prevNode) {
                    return true;
                }
                break;
            }

            case ParseNodeType.Function:
            case ParseNodeType.Module:
            case ParseNodeType.Class: {
                return false;
            }
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function isWithinAssertExpression(node: ParseNode): boolean {
    let curNode: ParseNode | undefined = node;
    let prevNode: ParseNode | undefined;

    while (curNode) {
        switch (curNode.nodeType) {
            case ParseNodeType.Assert: {
                return curNode.testExpression === prevNode;
            }
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function getDocString(statements: StatementNode[]): string | undefined {
    // See if the first statement in the suite is a triple-quote string.
    if (statements.length === 0) {
        return undefined;
    }

    if (statements[0].nodeType !== ParseNodeType.StatementList) {
        return undefined;
    }

    if (!isDocString(statements[0])) {
        return undefined;
    }

    // It's up to the user to convert normalize/convert this as needed.
    const strings = (statements[0].statements[0] as StringListNode).strings;
    if (strings.length === 1) {
        // Common case.
        return strings[0].value;
    }

    return strings.map((s) => s.value).join('');
}

export function isDocString(statementList: StatementListNode): boolean {
    // If the first statement in the suite isn't a StringNode,
    // assume there is no docString.
    if (statementList.statements.length === 0 || statementList.statements[0].nodeType !== ParseNodeType.StringList) {
        return false;
    }

    // A docstring can consist of multiple joined strings in a single expression.
    const strings = statementList.statements[0].strings;
    if (strings.length === 0) {
        return false;
    }

    // Any f-strings invalidate the entire docstring.
    if (strings.some((n) => (n.token.flags & StringTokenFlags.Format) !== 0)) {
        return false;
    }

    // It's up to the user to convert normalize/convert this as needed.
    return true;
}

// Sometimes a NamedTuple assignment statement is followed by a statement
// that looks like the following:
//    MyNamedTuple.__new__.__defaults__ = ...
// This pattern is commonly used to set the default values that are
// not specified in the original list.
export function isAssignmentToDefaultsFollowingNamedTuple(callNode: ParseNode): boolean {
    if (
        callNode.nodeType !== ParseNodeType.Call ||
        !callNode.parent ||
        callNode.parent.nodeType !== ParseNodeType.Assignment ||
        callNode.parent.leftExpression.nodeType !== ParseNodeType.Name ||
        !callNode.parent.parent ||
        callNode.parent.parent.nodeType !== ParseNodeType.StatementList
    ) {
        return false;
    }

    const namedTupleAssignedName = callNode.parent.leftExpression.value;
    const statementList = callNode.parent.parent;
    if (
        statementList.statements[0] !== callNode.parent ||
        !statementList.parent ||
        !(
            statementList.parent.nodeType === ParseNodeType.Module ||
            statementList.parent.nodeType === ParseNodeType.Suite
        )
    ) {
        return false;
    }

    const moduleOrSuite = statementList.parent;
    let statementIndex = moduleOrSuite.statements.findIndex((s) => s === statementList);

    if (statementIndex < 0) {
        return false;
    }
    statementIndex++;

    while (statementIndex < moduleOrSuite.statements.length) {
        const nextStatement = moduleOrSuite.statements[statementIndex];
        if (nextStatement.nodeType !== ParseNodeType.StatementList) {
            break;
        }

        if (nextStatement.statements[0]?.nodeType === ParseNodeType.StringList) {
            // Skip over comments
            statementIndex++;
            continue;
        }

        if (nextStatement.statements[0]?.nodeType === ParseNodeType.Assignment) {
            const assignNode = nextStatement.statements[0];
            if (
                assignNode.leftExpression.nodeType === ParseNodeType.MemberAccess &&
                assignNode.leftExpression.memberName.value === '__defaults__'
            ) {
                const defaultTarget = assignNode.leftExpression.leftExpression;
                if (
                    defaultTarget.nodeType === ParseNodeType.MemberAccess &&
                    defaultTarget.memberName.value === '__new__' &&
                    defaultTarget.leftExpression.nodeType === ParseNodeType.Name &&
                    defaultTarget.leftExpression.value === namedTupleAssignedName
                ) {
                    return true;
                }
            }
        }

        break;
    }

    return false;
}

// This simple parse tree walker calls a callback function
// for each NameNode it encounters.
export class NameNodeWalker extends ParseTreeWalker {
    private _subscriptIndex: number | undefined;
    private _baseExpression: ExpressionNode | undefined;

    constructor(
        private _callback: (
            node: NameNode,
            subscriptIndex: number | undefined,
            baseExpression: ExpressionNode | undefined
        ) => void
    ) {
        super();
    }

    override visitName(node: NameNode) {
        this._callback(node, this._subscriptIndex, this._baseExpression);
        return true;
    }

    override visitIndex(node: IndexNode) {
        this.walk(node.baseExpression);

        const prevSubscriptIndex = this._subscriptIndex;
        const prevBaseExpression = this._baseExpression;
        this._baseExpression = node.baseExpression;

        node.items.forEach((item, index) => {
            this._subscriptIndex = index;
            this.walk(item);
        });

        this._subscriptIndex = prevSubscriptIndex;
        this._baseExpression = prevBaseExpression;

        return false;
    }
}

export class CallNodeWalker extends ParseTreeWalker {
    constructor(private _callback: (node: CallNode) => void) {
        super();
    }

    override visitCall(node: CallNode) {
        this._callback(node);
        return true;
    }
}

export function getEnclosingParameter(node: ParseNode): ParameterNode | undefined {
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Parameter) {
            return curNode;
        }
        curNode = curNode.parent;
    }

    return undefined;
}

export function getCallNodeAndActiveParameterIndex(
    node: ParseNode,
    insertionOffset: number,
    tokens: TextRangeCollection<Token>
) {
    // Find the call node that contains the specified node.
    let curNode: ParseNode | undefined = node;
    let callNode: CallNode | undefined;

    while (curNode !== undefined) {
        // make sure we only look at callNodes when we are inside their arguments
        if (curNode.nodeType === ParseNodeType.Call) {
            if (isOffsetInsideCallArgs(curNode, insertionOffset)) {
                callNode = curNode;
                break;
            }
        }
        curNode = curNode.parent;
    }

    if (!callNode || !callNode.arguments) {
        return undefined;
    }

    const endPosition = TextRange.getEnd(callNode);
    if (insertionOffset > endPosition) {
        return undefined;
    }

    const tokenAtEnd = getTokenAt(tokens, endPosition - 1);
    if (insertionOffset === endPosition && tokenAtEnd?.type === TokenType.CloseParenthesis) {
        return undefined;
    }

    let addedActive = false;
    let activeIndex = -1;
    let activeOrFake = false;
    callNode.arguments.forEach((arg, index) => {
        if (addedActive) {
            return;
        }

        // Calculate the argument's bounds including whitespace and colons.
        let start = arg.start;
        const startTokenIndex = tokens.getItemAtPosition(start);
        if (startTokenIndex >= 0) {
            start = TextRange.getEnd(tokens.getItemAt(startTokenIndex - 1));
        }

        let end = TextRange.getEnd(arg);
        const endTokenIndex = tokens.getItemAtPosition(end);
        if (endTokenIndex >= 0) {
            // Find the true end of the argument by searching for the
            // terminating comma or parenthesis.
            for (let i = endTokenIndex; i < tokens.count; i++) {
                const tok = tokens.getItemAt(i);

                switch (tok.type) {
                    case TokenType.Comma:
                    case TokenType.CloseParenthesis:
                        break;
                    default:
                        continue;
                }

                end = TextRange.getEnd(tok);
                break;
            }
        }

        if (insertionOffset < end) {
            activeIndex = index;
            activeOrFake = insertionOffset >= start;
            addedActive = true;
        }
    });

    if (!addedActive) {
        activeIndex = callNode.arguments.length + 1;
    }

    return {
        callNode,
        activeIndex,
        activeOrFake,
    };

    function isOffsetInsideCallArgs(node: CallNode, offset: number) {
        let found = true;
        const argumentStart =
            node.leftExpression.length > 0 ? TextRange.getEnd(node.leftExpression) - 1 : node.leftExpression.start;
        const index = tokens.getItemAtPosition(argumentStart);
        if (index >= 0 && index + 1 < tokens.count) {
            const token = tokens.getItemAt(index + 1);
            if (token.type === TokenType.OpenParenthesis && insertionOffset < TextRange.getEnd(token)) {
                // position must be after '('
                found = false;
            }
        }
        return found;
    }
}

export function getTokenIndexAtLeft(
    tokens: TextRangeCollection<Token>,
    position: number,
    includeWhitespace = false,
    includeZeroLengthToken = false
) {
    const index = tokens.getItemAtPosition(position);
    if (index < 0) {
        return -1;
    }

    for (let i = index; i >= 0; i--) {
        const token = tokens.getItemAt(i);
        if (!includeZeroLengthToken && token.length === 0) {
            continue;
        }

        if (!includeWhitespace && isWhitespace(token)) {
            continue;
        }

        if (TextRange.getEnd(token) <= position) {
            return i;
        }
    }

    return -1;
}

export function getTokenAtLeft(
    tokens: TextRangeCollection<Token>,
    position: number,
    includeWhitespace = false,
    includeZeroLengthToken = false
) {
    const index = getTokenIndexAtLeft(tokens, position, includeWhitespace, includeZeroLengthToken);
    if (index < 0) {
        return undefined;
    }

    return tokens.getItemAt(index);
}

function isWhitespace(token: Token) {
    return token.type === TokenType.NewLine || token.type === TokenType.Indent || token.type === TokenType.Dedent;
}

export function getTokenAtIndex(tokens: TextRangeCollection<Token>, index: number) {
    if (index < 0) {
        return undefined;
    }

    return tokens.getItemAt(index);
}

export function getTokenAt(tokens: TextRangeCollection<Token>, position: number) {
    return getTokenAtIndex(tokens, tokens.getItemAtPosition(position));
}

export function getTokenOverlapping(tokens: TextRangeCollection<Token>, position: number) {
    const index = tokens.getItemAtPosition(position);
    if (index < 0) {
        return undefined;
    }

    const token = tokens.getItemAt(index);
    return TextRange.overlaps(token, position) ? token : undefined;
}

export function printParseNodeType(type: ParseNodeType) {
    switch (type) {
        case ParseNodeType.Error:
            return 'Error';

        case ParseNodeType.Argument:
            return 'Argument';

        case ParseNodeType.Assert:
            return 'Assert';

        case ParseNodeType.Assignment:
            return 'Assignment';

        case ParseNodeType.AssignmentExpression:
            return 'AssignmentExpression';

        case ParseNodeType.AugmentedAssignment:
            return 'AugmentedAssignment';

        case ParseNodeType.Await:
            return 'Await';

        case ParseNodeType.BinaryOperation:
            return 'BinaryOperation';

        case ParseNodeType.Break:
            return 'Break';

        case ParseNodeType.Call:
            return 'Call';

        case ParseNodeType.Class:
            return 'Class';

        case ParseNodeType.Constant:
            return 'Constant';

        case ParseNodeType.Continue:
            return 'Continue';

        case ParseNodeType.Decorator:
            return 'Decorator';

        case ParseNodeType.Del:
            return 'Del';

        case ParseNodeType.Dictionary:
            return 'Dictionary';

        case ParseNodeType.DictionaryExpandEntry:
            return 'DictionaryExpandEntry';

        case ParseNodeType.DictionaryKeyEntry:
            return 'DictionaryKeyEntry';

        case ParseNodeType.Ellipsis:
            return 'Ellipsis';

        case ParseNodeType.If:
            return 'If';

        case ParseNodeType.Import:
            return 'Import';

        case ParseNodeType.ImportAs:
            return 'ImportAs';

        case ParseNodeType.ImportFrom:
            return 'ImportFrom';

        case ParseNodeType.ImportFromAs:
            return 'ImportFromAs';

        case ParseNodeType.Index:
            return 'Index';

        case ParseNodeType.Except:
            return 'Except';

        case ParseNodeType.For:
            return 'For';

        case ParseNodeType.FormatString:
            return 'FormatString';

        case ParseNodeType.Function:
            return 'Function';

        case ParseNodeType.Global:
            return 'Global';

        case ParseNodeType.Lambda:
            return 'Lambda';

        case ParseNodeType.List:
            return 'List';

        case ParseNodeType.ListComprehension:
            return 'ListComprehension';

        case ParseNodeType.ListComprehensionFor:
            return 'ListComprehensionFor';

        case ParseNodeType.ListComprehensionIf:
            return 'ListComprehensionIf';

        case ParseNodeType.MemberAccess:
            return 'MemberAccess';

        case ParseNodeType.Module:
            return 'Module';

        case ParseNodeType.ModuleName:
            return 'ModuleName';

        case ParseNodeType.Name:
            return 'Name';

        case ParseNodeType.Nonlocal:
            return 'Nonlocal';

        case ParseNodeType.Number:
            return 'Number';

        case ParseNodeType.Parameter:
            return 'Parameter';

        case ParseNodeType.Pass:
            return 'Pass';

        case ParseNodeType.Raise:
            return 'Raise';

        case ParseNodeType.Return:
            return 'Return';

        case ParseNodeType.Set:
            return 'Set';

        case ParseNodeType.Slice:
            return 'Slice';

        case ParseNodeType.StatementList:
            return 'StatementList';

        case ParseNodeType.StringList:
            return 'StringList';

        case ParseNodeType.String:
            return 'String';

        case ParseNodeType.Suite:
            return 'Suite';

        case ParseNodeType.Ternary:
            return 'Ternary';

        case ParseNodeType.Tuple:
            return 'Tuple';

        case ParseNodeType.Try:
            return 'Try';

        case ParseNodeType.TypeAnnotation:
            return 'TypeAnnotation';

        case ParseNodeType.UnaryOperation:
            return 'UnaryOperation';

        case ParseNodeType.Unpack:
            return 'Unpack';

        case ParseNodeType.While:
            return 'While';

        case ParseNodeType.With:
            return 'With';

        case ParseNodeType.WithItem:
            return 'WithItem';

        case ParseNodeType.Yield:
            return 'Yield';

        case ParseNodeType.YieldFrom:
            return 'YieldFrom';

        case ParseNodeType.FunctionAnnotation:
            return 'FunctionAnnotation';

        case ParseNodeType.Match:
            return 'Match';

        case ParseNodeType.Case:
            return 'Case';

        case ParseNodeType.PatternSequence:
            return 'PatternSequence';

        case ParseNodeType.PatternAs:
            return 'PatternAs';

        case ParseNodeType.PatternLiteral:
            return 'PatternLiteral';

        case ParseNodeType.PatternClass:
            return 'PatternClass';

        case ParseNodeType.PatternCapture:
            return 'PatternCapture';

        case ParseNodeType.PatternMapping:
            return 'PatternMapping';

        case ParseNodeType.PatternMappingKeyEntry:
            return 'PatternMappingKeyEntry';

        case ParseNodeType.PatternMappingExpandEntry:
            return 'PatternMappingExpandEntry';

        case ParseNodeType.PatternValue:
            return 'PatternValue';

        case ParseNodeType.PatternClassArgument:
            return 'PatternClassArgument';

        case ParseNodeType.TypeParameter:
            return 'TypeParameter';

        case ParseNodeType.TypeParameterList:
            return 'TypeParameterList';

        case ParseNodeType.TypeAlias:
            return 'TypeAlias';
    }

    assertNever(type);
}

export function isWriteAccess(node: NameNode) {
    let prevNode: ParseNode = node;
    let curNode: ParseNode | undefined = prevNode.parent;

    while (curNode) {
        switch (curNode.nodeType) {
            case ParseNodeType.Assignment: {
                return prevNode === curNode.leftExpression;
            }

            case ParseNodeType.AugmentedAssignment: {
                return prevNode === curNode.leftExpression;
            }

            case ParseNodeType.AssignmentExpression: {
                return prevNode === curNode.name;
            }

            case ParseNodeType.Del: {
                return true;
            }

            case ParseNodeType.For: {
                return prevNode === curNode.targetExpression;
            }

            case ParseNodeType.ImportAs: {
                return (
                    prevNode === curNode.alias ||
                    (curNode.module.nameParts.length > 0 && prevNode === curNode.module.nameParts[0])
                );
            }

            case ParseNodeType.ImportFromAs: {
                return prevNode === curNode.alias || (!curNode.alias && prevNode === curNode.name);
            }

            case ParseNodeType.MemberAccess: {
                if (prevNode !== curNode.memberName) {
                    return false;
                }
                break;
            }

            case ParseNodeType.Except: {
                return prevNode === curNode.name;
            }

            case ParseNodeType.With: {
                return curNode.withItems.some((item) => item === prevNode);
            }

            case ParseNodeType.ListComprehensionFor: {
                return prevNode === curNode.targetExpression;
            }

            case ParseNodeType.TypeAnnotation: {
                if (prevNode === curNode.typeAnnotation) {
                    return false;
                }
                break;
            }

            case ParseNodeType.Function:
            case ParseNodeType.Class:
            case ParseNodeType.Module: {
                return false;
            }
        }

        prevNode = curNode;
        curNode = curNode.parent;
    }

    return false;
}

export function getModuleNode(node: ParseNode) {
    let current: ParseNode | undefined = node;
    while (current && current.nodeType !== ParseNodeType.Module) {
        current = current.parent;
    }

    return current;
}

export function getFileInfoFromNode(node: ParseNode) {
    const current = getModuleNode(node);
    return current ? AnalyzerNodeInfo.getFileInfo(current) : undefined;
}

export function isFunctionSuiteEmpty(node: FunctionNode) {
    let isEmpty = true;

    node.suite.statements.forEach((statement) => {
        if (statement.nodeType === ParseNodeType.Error) {
            return;
        } else if (statement.nodeType === ParseNodeType.StatementList) {
            statement.statements.forEach((subStatement) => {
                // Allow docstrings, ellipsis, and pass statements.
                if (
                    subStatement.nodeType !== ParseNodeType.Ellipsis &&
                    subStatement.nodeType !== ParseNodeType.StringList &&
                    subStatement.nodeType !== ParseNodeType.Pass
                ) {
                    isEmpty = false;
                }
            });
        } else {
            isEmpty = false;
        }
    });

    return isEmpty;
}

export function getTypeAnnotationForParameter(node: FunctionNode, paramIndex: number): ExpressionNode | undefined {
    if (paramIndex >= node.parameters.length) {
        return undefined;
    }

    const param = node.parameters[paramIndex];
    if (param.typeAnnotation) {
        return param.typeAnnotation;
    } else if (param.typeAnnotationComment) {
        return param.typeAnnotationComment;
    }

    if (!node.functionAnnotationComment || node.functionAnnotationComment.isParamListEllipsis) {
        return undefined;
    }

    let firstCommentAnnotationIndex = 0;
    const paramAnnotations = node.functionAnnotationComment.paramTypeAnnotations;
    if (paramAnnotations.length < node.parameters.length) {
        firstCommentAnnotationIndex = 1;
    }

    const adjIndex = paramIndex - firstCommentAnnotationIndex;
    if (adjIndex < 0 || adjIndex >= paramAnnotations.length) {
        return undefined;
    }

    return paramAnnotations[adjIndex];
}

export function isImportModuleName(node: ParseNode): boolean {
    return getFirstAncestorOrSelfOfKind(node, ParseNodeType.ModuleName)?.parent?.nodeType === ParseNodeType.ImportAs;
}

export function isImportAlias(node: ParseNode): boolean {
    return node.parent?.nodeType === ParseNodeType.ImportAs && node.parent.alias === node;
}

export function isFromImportModuleName(node: ParseNode): boolean {
    return getFirstAncestorOrSelfOfKind(node, ParseNodeType.ModuleName)?.parent?.nodeType === ParseNodeType.ImportFrom;
}

export function isFromImportName(node: ParseNode): boolean {
    return node.parent?.nodeType === ParseNodeType.ImportFromAs && node.parent.name === node;
}

export function isFromImportAlias(node: ParseNode): boolean {
    return node.parent?.nodeType === ParseNodeType.ImportFromAs && node.parent.alias === node;
}

export function isLastNameOfModuleName(node: NameNode): boolean {
    if (node.parent?.nodeType !== ParseNodeType.ModuleName) {
        return false;
    }

    const module = node.parent;
    if (module.nameParts.length === 0) {
        return false;
    }

    return module.nameParts[module.nameParts.length - 1] === node;
}

function* _getAncestorsIncludingSelf(node: ParseNode | undefined) {
    while (node !== undefined) {
        yield node;
        node = node.parent;
    }
}

type NodeForType<NT extends ParseNodeType, T extends ParseNode> = T extends ParseNode & { nodeType: NT } ? T : never;

export function getFirstAncestorOrSelfOfKind<NT extends ParseNodeType, T extends ParseNode>(
    node: ParseNode | undefined,
    type: NT
): NodeForType<NT, T> | undefined {
    return getFirstAncestorOrSelf(node, (n) => n.nodeType === type) as NodeForType<NT, T> | undefined;
}

export function getFirstAncestorOrSelf(
    node: ParseNode | undefined,
    predicate: (node: ParseNode) => boolean
): ParseNode | undefined {
    for (const current of _getAncestorsIncludingSelf(node)) {
        if (predicate(current)) {
            return current;
        }
    }

    return undefined;
}

export function getDottedNameWithGivenNodeAsLastName(node: NameNode): MemberAccessNode | NameNode {
    // Shape of dotted name is
    //    MemberAccess (ex, a.b)
    //  Name        Name
    // or
    //           MemberAccess (ex, a.b.c)
    //    MemberAccess     Name
    //  Name       Name
    if (node.parent?.nodeType !== ParseNodeType.MemberAccess) {
        return node;
    }

    if (node.parent.leftExpression === node) {
        return node;
    }

    return node.parent;
}

export function getDottedName(node: MemberAccessNode | NameNode): NameNode[] | undefined {
    // ex) [a] or [a].b
    // simple case, [a]
    if (node.nodeType === ParseNodeType.Name) {
        return [node];
    }

    // dotted name case.
    const names: NameNode[] = [];
    if (_getDottedName(node, names)) {
        return names.reverse();
    }

    return undefined;

    function _getDottedName(node: MemberAccessNode | NameNode, names: NameNode[]): boolean {
        if (node.nodeType === ParseNodeType.Name) {
            names.push(node);
            return true;
        }

        names.push(node.memberName);

        if (
            node.leftExpression.nodeType === ParseNodeType.Name ||
            node.leftExpression.nodeType === ParseNodeType.MemberAccess
        ) {
            return _getDottedName(node.leftExpression, names);
        }

        return false;
    }
}

export function getFirstNameOfDottedName(node: MemberAccessNode | NameNode): NameNode | undefined {
    // ex) [a] or [a].b
    if (node.nodeType === ParseNodeType.Name) {
        return node;
    }

    if (
        node.leftExpression.nodeType === ParseNodeType.Name ||
        node.leftExpression.nodeType === ParseNodeType.MemberAccess
    ) {
        return getFirstNameOfDottedName(node.leftExpression);
    }

    return undefined;
}

export function isFirstNameOfDottedName(node: NameNode): boolean {
    // ex) [A] or [A].B.C.D
    if (node.parent?.nodeType !== ParseNodeType.MemberAccess) {
        return true;
    }

    if (node.parent.leftExpression === node) {
        return true;
    }

    return false;
}

export function isLastNameOfDottedName(node: NameNode): boolean {
    // ex) A or D.C.B.[A]
    if (node.parent?.nodeType !== ParseNodeType.MemberAccess) {
        return true;
    }

    if (
        node.parent.leftExpression.nodeType !== ParseNodeType.Name &&
        node.parent.leftExpression.nodeType !== ParseNodeType.MemberAccess
    ) {
        return false;
    }

    if (node.parent.leftExpression === node) {
        return false;
    }

    return node.parent.parent?.nodeType !== ParseNodeType.MemberAccess;
}

export function getStringNodeValueRange(node: StringNode) {
    return getStringValueRange(node.token);
}

export function getStringValueRange(token: StringToken) {
    const length = token.quoteMarkLength;
    const hasEnding = !(token.flags & StringTokenFlags.Unterminated);
    return TextRange.create(token.start + length, token.length - length - (hasEnding ? length : 0));
}

export function getFullStatementRange(statementNode: ParseNode, tokenizerOutput: TokenizerOutput): Range {
    const range = convertTextRangeToRange(statementNode, tokenizerOutput.lines);

    // First, see whether there are other tokens except semicolon or new line on the same line.
    const endPosition = _getEndPositionIfMultipleStatementsAreOnSameLine(
        range,
        TextRange.getEnd(statementNode),
        tokenizerOutput
    );

    if (endPosition) {
        return { start: range.start, end: endPosition };
    }

    // If not, delete the whole line.
    if (range.end.line === tokenizerOutput.lines.count - 1) {
        return range;
    }

    return { start: range.start, end: { line: range.end.line + 1, character: 0 } };
}

export function isUnannotatedFunction(node: FunctionNode) {
    return (
        node.returnTypeAnnotation === undefined &&
        node.parameters.every(
            (param) => param.typeAnnotation === undefined && param.typeAnnotationComment === undefined
        )
    );
}

function _getEndPositionIfMultipleStatementsAreOnSameLine(
    range: Range,
    tokenPosition: number,
    tokenizerOutput: TokenizerOutput
): Position | undefined {
    const tokenIndex = tokenizerOutput.tokens.getItemAtPosition(tokenPosition);
    if (tokenIndex < 0) {
        return undefined;
    }

    let currentIndex = tokenIndex;
    for (; currentIndex < tokenizerOutput.tokens.count; currentIndex++) {
        const token = tokenizerOutput.tokens.getItemAt(currentIndex);
        const tokenRange = convertTextRangeToRange(token, tokenizerOutput.lines);
        if (range.end.line !== tokenRange.start.line) {
            break;
        }
    }

    for (let index = tokenIndex; index < currentIndex; index++) {
        const token = tokenizerOutput.tokens.getItemAt(index);
        if (token.type === TokenType.Semicolon || token.type === TokenType.NewLine) {
            continue;
        }

        const tokenRange = convertTextRangeToRange(token, tokenizerOutput.lines);
        return tokenRange.start;
    }

    return undefined;
}
