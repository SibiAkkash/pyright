/*
 * constraintSolver.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Code that solves a TypeVar, TypeVarTuple or ParamSpec based on
 * all of the provided constraints.
 *
 */

import { DiagnosticAddendum } from '../common/diagnostic';
import { Localizer } from '../localization/localize';
import { maxSubtypesForInferredType, TypeEvaluator } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    FunctionType,
    FunctionTypeFlags,
    isAny,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isInstantiableClass,
    isNever,
    isTypeSame,
    isTypeVar,
    isUnion,
    isUnknown,
    isUnpacked,
    isVariadicTypeVar,
    ParamSpecEntry,
    Type,
    TypeBase,
    TypeVarScopeId,
    TypeVarType,
    UnknownType,
    Variance,
} from './types';
import {
    addConditionToType,
    AssignTypeFlags,
    buildTypeVarContextFromSpecializedClass,
    containsLiteralType,
    convertParamSpecValueToType,
    convertToInstance,
    convertToInstantiable,
    getTypeCondition,
    getTypeVarScopeId,
    isEffectivelyInstantiable,
    isPartlyUnknown,
    mapSubtypes,
    specializeTupleClass,
    stripLiteralValue,
    transformExpectedTypeForConstructor,
} from './typeUtils';
import { TypeVarContext } from './typeVarContext';

// Assigns the source type to the dest type var in the type var context. If an existing
// type is already associated with that type var name, it attempts to either widen or
// narrow the type (depending on the value of the isContravariant parameter). The goal is
// to produce the narrowest type that meets all of the requirements. If the type var context
// has been "locked", it simply validates that the srcType is compatible (with no attempt
// to widen or narrow).
export function assignTypeToTypeVar(
    evaluator: TypeEvaluator,
    destType: TypeVarType,
    srcType: Type,
    diag: DiagnosticAddendum | undefined,
    typeVarContext: TypeVarContext,
    flags = AssignTypeFlags.Default,
    recursionCount = 0
): boolean {
    let isTypeVarInScope = true;
    const isContravariant = (flags & AssignTypeFlags.ReverseTypeVarMatching) !== 0;

    // If the TypeVar doesn't have a scope ID, then it's being used
    // outside of a valid TypeVar scope. This will be reported as a
    // separate error. Just ignore this case to avoid redundant errors.
    if (!destType.scopeId) {
        return true;
    }

    // Verify that we are solving for the scope associated with this
    // type variable.
    if (!typeVarContext.hasSolveForScope(destType.scopeId)) {
        if (isAnyOrUnknown(srcType) || (isClass(srcType) && ClassType.derivesFromAnyOrUnknown(srcType))) {
            return true;
        }

        // If we're in "ignore type var scope" mode, don't generate
        // an error in this path.
        if ((flags & AssignTypeFlags.IgnoreTypeVarScope) !== 0) {
            return true;
        }

        // If we're in "reverse type var" mode, simply make sure that
        // the concrete type is assignable.
        if (isContravariant) {
            if (
                evaluator.assignType(
                    evaluator.makeTopLevelTypeVarsConcrete(destType),
                    evaluator.makeTopLevelTypeVarsConcrete(srcType),
                    /* diag */ undefined,
                    /* destTypeVarContext */ undefined,
                    /* srcTypeVarContext */ undefined,
                    flags,
                    recursionCount
                )
            ) {
                return true;
            }
        }

        isTypeVarInScope = false;
        if (!destType.details.isSynthesized) {
            diag?.addMessage(
                Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                    sourceType: evaluator.printType(srcType),
                    destType: evaluator.printType(destType),
                })
            );
            return false;
        }
    }

    if ((flags & AssignTypeFlags.SkipSolveTypeVars) !== 0) {
        return evaluator.assignType(
            evaluator.makeTopLevelTypeVarsConcrete(destType),
            evaluator.makeTopLevelTypeVarsConcrete(srcType),
            diag,
            /* destTypeVarContext */ undefined,
            /* srcTypeVarContext */ undefined,
            flags,
            recursionCount
        );
    }

    if (destType.details.isParamSpec) {
        return assignTypeToParamSpec(evaluator, destType, srcType, diag, typeVarContext, recursionCount);
    }

    if (destType.details.isVariadic) {
        if (!isUnpacked(srcType)) {
            const tupleClassType = evaluator.getTupleClassType();
            if (tupleClassType && isInstantiableClass(tupleClassType)) {
                // Package up the type into a tuple.
                srcType = convertToInstance(
                    specializeTupleClass(
                        tupleClassType,
                        [{ type: srcType, isUnbounded: false }],
                        /* isTypeArgumentExplicit */ true,
                        /* isUnpackedTuple */ true
                    )
                );
            } else {
                srcType = UnknownType.create();
            }
        }
    }

    // If we're attempting to assign `type` to Type[T], transform `type` into `Type[Any]`.
    if (
        TypeBase.isInstantiable(destType) &&
        isClassInstance(srcType) &&
        ClassType.isBuiltIn(srcType, 'type') &&
        !srcType.typeArguments
    ) {
        srcType = AnyType.create();
    }

    const curEntry = typeVarContext.getTypeVar(destType);
    const curNarrowTypeBound = curEntry?.narrowBound;
    const curWideTypeBound = curEntry?.wideBound ?? destType.details.boundType;

    // Handle the constrained case. This case needs to be handled specially
    // because type narrowing isn't used in this case. For example, if the
    // source type is "Literal[1]" and the constraint list includes the type
    // "float", the resulting type is float.
    if (destType.details.constraints.length > 0) {
        let constrainedType: Type | undefined;
        const concreteSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);

        if (isTypeVar(srcType)) {
            if (
                evaluator.assignType(
                    destType,
                    concreteSrcType,
                    /* diag */ undefined,
                    new TypeVarContext(destType.scopeId),
                    /* srcTypeVarContext */ undefined,
                    AssignTypeFlags.Default,
                    recursionCount
                )
            ) {
                constrainedType = srcType;

                // If the source and dest are both instantiables (type[T]), then
                // we need to convert to an instance (T) for the
                if (TypeBase.isInstantiable(srcType)) {
                    constrainedType = convertToInstance(srcType, /* includeSubclasses */ false);
                }
            }
        } else {
            let isCompatible = true;

            // Subtypes that are not conditionally dependent on the dest type var
            // must all map to the same constraint. For example, Union[str, bytes]
            // cannot be assigned to AnyStr.
            let unconditionalConstraintIndex: number | undefined;

            // Find the narrowest constrained type that is compatible.
            constrainedType = mapSubtypes(concreteSrcType, (srcSubtype) => {
                let constrainedSubtype: Type | undefined;

                if (isAnyOrUnknown(srcSubtype)) {
                    return srcSubtype;
                }

                let constraintIndexUsed: number | undefined;
                destType.details.constraints.forEach((constraint, i) => {
                    const adjustedConstraint = TypeBase.isInstantiable(destType)
                        ? convertToInstantiable(constraint)
                        : constraint;
                    if (
                        evaluator.assignType(
                            adjustedConstraint,
                            srcSubtype,
                            /* diag */ undefined,
                            /* destTypeVarContext */ undefined,
                            /* srcTypeVarContext */ undefined,
                            AssignTypeFlags.Default,
                            recursionCount
                        )
                    ) {
                        if (
                            !constrainedSubtype ||
                            evaluator.assignType(
                                TypeBase.isInstantiable(destType)
                                    ? convertToInstantiable(constrainedSubtype)
                                    : constrainedSubtype,
                                adjustedConstraint,
                                /* diag */ undefined,
                                /* destTypeVarContext */ undefined,
                                /* srcTypeVarContext */ undefined,
                                AssignTypeFlags.Default,
                                recursionCount
                            )
                        ) {
                            constrainedSubtype = addConditionToType(constraint, getTypeCondition(srcSubtype));
                            constraintIndexUsed = i;
                        }
                    }
                });

                if (!constrainedSubtype) {
                    // We found a source subtype that is not compatible with the dest.
                    // This is OK if we're handling the contravariant case because only
                    // one subtype needs to be assignable in that case.
                    if (!isContravariant) {
                        isCompatible = false;
                    }
                }

                // If this subtype isn't conditional, make sure it maps to the same
                // constraint index as previous unconditional subtypes.
                if (constraintIndexUsed !== undefined && !getTypeCondition(srcSubtype)) {
                    if (
                        unconditionalConstraintIndex !== undefined &&
                        unconditionalConstraintIndex !== constraintIndexUsed
                    ) {
                        isCompatible = false;
                    }

                    unconditionalConstraintIndex = constraintIndexUsed;
                }

                return constrainedSubtype;
            });

            if (isNever(constrainedType) || !isCompatible) {
                constrainedType = undefined;
            }

            // If the type is a union, see if the entire union is assignable to one
            // of the constraints.
            if (!constrainedType && isUnion(concreteSrcType)) {
                constrainedType = destType.details.constraints.find((constraint) => {
                    const adjustedConstraint = TypeBase.isInstantiable(destType)
                        ? convertToInstantiable(constraint)
                        : constraint;
                    return evaluator.assignType(
                        adjustedConstraint,
                        concreteSrcType,
                        /* diag */ undefined,
                        /* destTypeVarContext */ undefined,
                        /* srcTypeVarContext */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    );
                });
            }
        }

        // If there was no constrained type that was assignable
        // or there were multiple types that were assignable and they
        // are not conditional, it's an error.
        if (!constrainedType) {
            diag?.addMessage(
                Localizer.DiagnosticAddendum.typeConstrainedTypeVar().format({
                    type: evaluator.printType(srcType),
                    name: destType.details.name,
                })
            );
            return false;
        }

        if (curNarrowTypeBound && !isAnyOrUnknown(curNarrowTypeBound)) {
            if (
                !evaluator.assignType(
                    curNarrowTypeBound,
                    constrainedType,
                    /* diag */ undefined,
                    /* destTypeVarContext */ undefined,
                    /* srcTypeVarContext */ undefined,
                    AssignTypeFlags.Default,
                    recursionCount
                )
            ) {
                // Handle the case where one of the constrained types is a wider
                // version of another constrained type that was previously assigned
                // to the type variable.
                if (
                    evaluator.assignType(
                        constrainedType,
                        curNarrowTypeBound,
                        /* diag */ undefined,
                        /* destTypeVarContext */ undefined,
                        /* srcTypeVarContext */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    )
                ) {
                    if (!typeVarContext.isLocked() && isTypeVarInScope) {
                        typeVarContext.setTypeVarType(destType, constrainedType);
                    }
                } else {
                    diag?.addMessage(
                        Localizer.DiagnosticAddendum.typeConstrainedTypeVar().format({
                            type: evaluator.printType(constrainedType),
                            name: evaluator.printType(curNarrowTypeBound),
                        })
                    );
                    return false;
                }
            }
        } else {
            // Assign the type to the type var.
            if (!typeVarContext.isLocked() && isTypeVarInScope) {
                typeVarContext.setTypeVarType(destType, constrainedType);
            }
        }

        return true;
    }

    // Handle the unconstrained (but possibly bound) case.
    let newNarrowTypeBound = curNarrowTypeBound;
    let newWideTypeBound = curWideTypeBound;
    const diagAddendum = diag ? new DiagnosticAddendum() : undefined;

    // Strip literals if the existing value contains no literals. This allows
    // for explicit (but no implicit) literal specialization of a generic class.
    const retainLiterals =
        (flags & AssignTypeFlags.RetainLiteralsForTypeVar) !== 0 ||
        typeVarContext.getRetainLiterals(destType) ||
        (destType.details.boundType && containsLiteralType(destType.details.boundType)) ||
        destType.details.constraints.some((t) => containsLiteralType(t));
    let adjSrcType = retainLiterals ? srcType : stripLiteralValue(srcType);

    if (TypeBase.isInstantiable(destType)) {
        if (isEffectivelyInstantiable(adjSrcType)) {
            adjSrcType = convertToInstance(adjSrcType, /* includeSubclasses */ false);
        } else {
            diag?.addMessage(
                Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                    sourceType: evaluator.printType(adjSrcType),
                    destType: evaluator.printType(destType),
                })
            );
            return false;
        }
    }

    if (isContravariant || (flags & AssignTypeFlags.AllowTypeVarNarrowing) !== 0) {
        // Update the wide type bound.
        if (!curWideTypeBound) {
            newWideTypeBound = adjSrcType;
        } else if (
            !isTypeSame(
                curWideTypeBound,
                adjSrcType,
                /* ignorePseudoGeneric */ undefined,
                /* ignoreTypeFlags */ undefined,
                recursionCount
            )
        ) {
            if (
                evaluator.assignType(
                    curWideTypeBound,
                    evaluator.makeTopLevelTypeVarsConcrete(adjSrcType),
                    diagAddendum,
                    /* destTypeVarContext */ undefined,
                    /* srcTypeVarContext */ undefined,
                    flags & AssignTypeFlags.IgnoreTypeVarScope,
                    recursionCount
                )
            ) {
                // The srcType is narrower than the current wideTypeBound, so replace it.
                newWideTypeBound = adjSrcType;
            } else if (
                !evaluator.assignType(
                    adjSrcType,
                    curWideTypeBound,
                    diagAddendum,
                    /* destTypeVarContext */ undefined,
                    /* srcTypeVarContext */ undefined,
                    flags & AssignTypeFlags.IgnoreTypeVarScope,
                    recursionCount
                )
            ) {
                if (diag && diagAddendum) {
                    diag.addMessage(
                        Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                            sourceType: evaluator.printType(adjSrcType),
                            destType: evaluator.printType(curWideTypeBound),
                        })
                    );
                    diag.addAddendum(diagAddendum);
                }
                return false;
            }
        }

        // Make sure we haven't narrowed it beyond the current narrow bound.
        if (curNarrowTypeBound) {
            if (
                !evaluator.assignType(
                    newWideTypeBound!,
                    curNarrowTypeBound,
                    /* diag */ undefined,
                    /* destTypeVarContext */ undefined,
                    /* srcTypeVarContext */ undefined,
                    flags & AssignTypeFlags.IgnoreTypeVarScope,
                    recursionCount
                )
            ) {
                if (diag && diagAddendum) {
                    diag.addMessage(
                        Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                            sourceType: evaluator.printType(adjSrcType),
                            destType: evaluator.printType(curNarrowTypeBound),
                        })
                    );
                    diag.addAddendum(diagAddendum);
                }
                return false;
            }
        }
    } else {
        if (!curNarrowTypeBound) {
            // There was previously no narrow bound. We've now established one.
            newNarrowTypeBound = adjSrcType;
        } else if (
            !isTypeSame(
                curNarrowTypeBound,
                adjSrcType,
                /* ignorePseudoGeneric */ undefined,
                /* ignoreTypeFlags */ undefined,
                recursionCount
            )
        ) {
            if (
                evaluator.assignType(
                    curNarrowTypeBound,
                    adjSrcType,
                    diagAddendum,
                    new TypeVarContext(destType.scopeId),
                    /* srcTypeVarContext */ undefined,
                    flags,
                    recursionCount
                )
            ) {
                // No need to widen. Stick with the existing type unless it's unknown
                // or partly unknown, in which case we'll replace it with a known type
                // as long as it doesn't violate the current narrow bound.
                if (
                    isPartlyUnknown(curNarrowTypeBound) &&
                    !isUnknown(adjSrcType) &&
                    evaluator.assignType(
                        adjSrcType,
                        curNarrowTypeBound,
                        /* diag */ undefined,
                        new TypeVarContext(destType.scopeId),
                        /* srcTypeVarContext */ undefined,
                        flags & AssignTypeFlags.IgnoreTypeVarScope,
                        recursionCount
                    )
                ) {
                    newNarrowTypeBound = adjSrcType;
                } else {
                    newNarrowTypeBound = curNarrowTypeBound;
                }
            } else {
                // We need to widen the type.
                if (typeVarContext.isLocked()) {
                    diag?.addMessage(
                        Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                            sourceType: evaluator.printType(curNarrowTypeBound),
                            destType: evaluator.printType(adjSrcType),
                        })
                    );
                    return false;
                }

                // Don't allow widening for variadic type variables.
                const possibleVariadic = destType;
                if (isVariadicTypeVar(possibleVariadic)) {
                    diag?.addMessage(
                        Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                            sourceType: evaluator.printType(curNarrowTypeBound),
                            destType: evaluator.printType(adjSrcType),
                        })
                    );
                    return false;
                }

                if (
                    evaluator.assignType(
                        adjSrcType,
                        curNarrowTypeBound,
                        /* diag */ undefined,
                        new TypeVarContext(destType.scopeId),
                        /* srcTypeVarContext */ undefined,
                        flags & AssignTypeFlags.IgnoreTypeVarScope,
                        recursionCount
                    )
                ) {
                    newNarrowTypeBound = adjSrcType;
                } else {
                    const objectType = evaluator.getObjectType();

                    // In some extreme edge cases, the narrow type bound can become
                    // a union with so many subtypes that performance grinds to a
                    // halt. We'll detect this case and widen the resulting type
                    // to an 'object' instead of making the union even bigger. This
                    // is still a valid solution to the TypeVar.
                    if (
                        isUnion(curNarrowTypeBound) &&
                        curNarrowTypeBound.subtypes.length > maxSubtypesForInferredType &&
                        (destType as TypeVarType).details.boundType !== undefined &&
                        objectType &&
                        isClassInstance(objectType)
                    ) {
                        newNarrowTypeBound = combineTypes([curNarrowTypeBound, objectType]);
                    } else {
                        newNarrowTypeBound = combineTypes([curNarrowTypeBound, adjSrcType]);
                    }
                }
            }
        }

        // Make sure we don't exceed the wide type bound.
        if (curWideTypeBound && newNarrowTypeBound) {
            if (
                !isTypeSame(
                    curWideTypeBound,
                    newNarrowTypeBound,
                    /* ignorePseudoGeneric */ undefined,
                    /* ignoreTypeFlags */ undefined,
                    recursionCount
                )
            ) {
                let makeConcrete = true;

                // Handle the case where the wide type is type T and the narrow type
                // is type T | <some other type>. In this case, it violates the
                // wide type bound.
                if (isTypeVar(curWideTypeBound)) {
                    if (isTypeSame(newNarrowTypeBound, curWideTypeBound)) {
                        makeConcrete = false;
                    } else if (
                        isUnion(newNarrowTypeBound) &&
                        newNarrowTypeBound.subtypes.some((subtype) => isTypeSame(subtype, curWideTypeBound))
                    ) {
                        makeConcrete = false;
                    }
                }

                if (
                    !evaluator.assignType(
                        makeConcrete ? evaluator.makeTopLevelTypeVarsConcrete(curWideTypeBound) : curWideTypeBound,
                        newNarrowTypeBound,
                        diag?.createAddendum(),
                        new TypeVarContext(destType.scopeId),
                        /* srcTypeVarContext */ undefined,
                        flags & AssignTypeFlags.IgnoreTypeVarScope,
                        recursionCount
                    )
                ) {
                    if (diag && diagAddendum) {
                        diag.addMessage(
                            Localizer.DiagnosticAddendum.typeAssignmentMismatch().format({
                                sourceType: evaluator.printType(adjSrcType),
                                destType: evaluator.printType(curWideTypeBound),
                            })
                        );
                    }
                    return false;
                }
            }
        }
    }

    // If there's a bound type, make sure the source is assignable to it.
    if (destType.details.boundType) {
        const updatedType = (newNarrowTypeBound || newWideTypeBound)!;

        // If the dest is a Type[T] but the source is not a valid Type,
        // skip the assignType check and the diagnostic addendum, which will
        // be confusing and inaccurate.
        if (TypeBase.isInstantiable(destType) && !TypeBase.isInstantiable(srcType)) {
            return false;
        }

        // In general, bound types cannot be generic, but the "Self" type is an
        // exception. In this case, we need to use the original TypeVarContext
        // to solve for the generic type variable(s) in the bound type.
        const effectiveTypeVarContext = destType.details.isSynthesizedSelf
            ? typeVarContext
            : new TypeVarContext(destType.scopeId);

        if (
            !evaluator.assignType(
                destType.details.boundType,
                evaluator.makeTopLevelTypeVarsConcrete(updatedType),
                diag?.createAddendum(),
                effectiveTypeVarContext,
                /* srcTypeVarContext */ undefined,
                flags & AssignTypeFlags.IgnoreTypeVarScope,
                recursionCount
            )
        ) {
            // Avoid adding a message that will confuse users if the TypeVar was
            // synthesized for internal purposes.
            if (!destType.details.isSynthesized) {
                diag?.addMessage(
                    Localizer.DiagnosticAddendum.typeBound().format({
                        sourceType: evaluator.printType(updatedType),
                        destType: evaluator.printType(destType.details.boundType),
                        name: TypeVarType.getReadableName(destType),
                    })
                );
            }
            return false;
        }
    }

    if (!typeVarContext.isLocked() && isTypeVarInScope) {
        typeVarContext.setTypeVarType(destType, newNarrowTypeBound, newWideTypeBound, retainLiterals);
    }

    return true;
}

function assignTypeToParamSpec(
    evaluator: TypeEvaluator,
    destType: TypeVarType,
    srcType: Type,
    diag: DiagnosticAddendum | undefined,
    typeVarContext: TypeVarContext,
    recursionCount = 0
) {
    if (isTypeVar(srcType) && srcType.details.isParamSpec) {
        const existingEntry = typeVarContext.getParamSpec(destType);
        if (existingEntry) {
            if (existingEntry.parameters.length === 0 && existingEntry.paramSpec) {
                // If there's an existing entry that matches, that's fine.
                if (
                    isTypeSame(
                        existingEntry.paramSpec,
                        srcType,
                        /* ignorePseudoGeneric */ undefined,
                        /* ignoreTypeFlags */ undefined,
                        recursionCount
                    )
                ) {
                    return true;
                }
            }
        } else {
            if (!typeVarContext.isLocked() && typeVarContext.hasSolveForScope(destType.scopeId)) {
                typeVarContext.setParamSpec(destType, {
                    flags: FunctionTypeFlags.None,
                    parameters: [],
                    typeVarScopeId: undefined,
                    docString: undefined,
                    paramSpec: srcType,
                });
            }
            return true;
        }
    } else if (isFunction(srcType)) {
        const functionSrcType = srcType;
        const parameters = srcType.details.parameters.map((p, index) => {
            const paramSpecEntry: ParamSpecEntry = {
                category: p.category,
                name: p.name,
                isNameSynthesized: p.isNameSynthesized,
                hasDefault: !!p.hasDefault,
                type: FunctionType.getEffectiveParameterType(functionSrcType, index),
            };
            return paramSpecEntry;
        });

        const existingEntry = typeVarContext.getParamSpec(destType);
        if (existingEntry) {
            if (existingEntry.paramSpec === srcType.details.paramSpec) {
                // Convert the remaining portion of the signature to a function
                // for comparison purposes.
                const existingFunction = convertParamSpecValueToType(existingEntry, /* omitParamSpec */ true);
                const assignedFunction = convertParamSpecValueToType(
                    {
                        parameters,
                        flags: srcType.details.flags,
                        typeVarScopeId: srcType.details.typeVarScopeId,
                        docString: undefined,
                        paramSpec: undefined,
                    },
                    /* omitParamSpec */ true
                );

                if (
                    evaluator.assignType(
                        existingFunction,
                        assignedFunction,
                        /* diag */ undefined,
                        /* destTypeVarContext */ undefined,
                        /* srcTypeVarContext */ undefined,
                        AssignTypeFlags.SkipFunctionReturnTypeCheck,
                        recursionCount
                    )
                ) {
                    return true;
                }
            }
        } else {
            if (!typeVarContext.isLocked() && typeVarContext.hasSolveForScope(destType.scopeId)) {
                typeVarContext.setParamSpec(destType, {
                    parameters,
                    typeVarScopeId: srcType.details.typeVarScopeId,
                    flags: srcType.details.flags,
                    docString: srcType.details.docString,
                    paramSpec: srcType.details.paramSpec,
                });
            }
            return true;
        }
    } else if (isAnyOrUnknown(srcType)) {
        return true;
    }

    diag?.addMessage(
        Localizer.DiagnosticAddendum.typeParamSpec().format({
            type: evaluator.printType(srcType),
            name: destType.details.name,
        })
    );
    return false;
}

// In cases where the expected type is a specialized base class of the
// source type, we need to determine which type arguments in the derived
// class will make it compatible with the specialized base class. This method
// performs this reverse mapping of type arguments and populates the type var
// map for the target type. If the type is not assignable to the expected type,
// it returns false.
export function populateTypeVarContextBasedOnExpectedType(
    evaluator: TypeEvaluator,
    type: ClassType,
    expectedType: Type,
    typeVarContext: TypeVarContext,
    liveTypeVarScopes: TypeVarScopeId[] | undefined
): boolean {
    if (isAny(expectedType)) {
        type.details.typeParameters.forEach((typeParam) => {
            typeVarContext.setTypeVarType(typeParam, expectedType);
        });
        return true;
    }

    if (!isClass(expectedType)) {
        return false;
    }

    // If the expected type is generic (but not specialized), we can't proceed.
    const expectedTypeArgs = expectedType.typeArguments;
    if (!expectedTypeArgs) {
        return evaluator.assignType(
            type,
            expectedType,
            /* diag */ undefined,
            typeVarContext,
            /* srcTypeVarContext */ undefined,
            AssignTypeFlags.PopulatingExpectedType
        );
    }

    evaluator.inferTypeParameterVarianceForClass(type);

    // If the expected type is the same as the target type (commonly the case),
    // we can use a faster method.
    if (ClassType.isSameGenericClass(expectedType, type)) {
        const sameClassTypeVarContext = buildTypeVarContextFromSpecializedClass(expectedType);
        sameClassTypeVarContext.getTypeVars().forEach((entry) => {
            const typeVarType = sameClassTypeVarContext.getTypeVarType(entry.typeVar);

            if (typeVarType) {
                // Skip this if the type argument is a TypeVar defined by the class scope because
                // we're potentially solving for these TypeVars.
                if (!isTypeVar(typeVarType) || typeVarType.scopeId !== type.details.typeVarScopeId) {
                    typeVarContext.setTypeVarType(
                        entry.typeVar,
                        TypeVarType.getVariance(entry.typeVar) === Variance.Covariant ? undefined : typeVarType,
                        TypeVarType.getVariance(entry.typeVar) === Variance.Contravariant ? undefined : typeVarType,
                        entry.retainLiteral
                    );
                }
            }
        });
        return true;
    }

    // Create a generic version of the expected type.
    const expectedTypeScopeId = getTypeVarScopeId(expectedType);
    const synthExpectedTypeArgs = ClassType.getTypeParameters(expectedType).map((typeParam, index) => {
        const typeVar = TypeVarType.createInstance(`__dest${index}`);
        typeVar.details.isSynthesized = true;

        // Use invariance here so we set the narrow and wide values on the TypeVar.
        typeVar.details.declaredVariance = Variance.Invariant;
        typeVar.scopeId = expectedTypeScopeId;
        return typeVar;
    });
    const genericExpectedType = ClassType.cloneForSpecialization(
        expectedType,
        synthExpectedTypeArgs,
        /* isTypeArgumentExplicit */ true
    );

    // For each type param in the target type, create a placeholder type variable.
    const typeArgs = ClassType.getTypeParameters(type).map((_, index) => {
        const typeVar = TypeVarType.createInstance(`__source${index}`);
        typeVar.details.isSynthesized = true;
        typeVar.details.synthesizedIndex = index;
        typeVar.details.isExemptFromBoundCheck = true;
        return typeVar;
    });

    const specializedType = ClassType.cloneForSpecialization(type, typeArgs, /* isTypeArgumentExplicit */ true);
    const syntheticTypeVarContext = new TypeVarContext(expectedTypeScopeId);
    if (
        evaluator.assignType(
            genericExpectedType,
            specializedType,
            /* diag */ undefined,
            syntheticTypeVarContext,
            /* srcTypeVarContext */ undefined,
            AssignTypeFlags.PopulatingExpectedType
        )
    ) {
        let isResultValid = true;

        synthExpectedTypeArgs.forEach((typeVar, index) => {
            const synthTypeVar = syntheticTypeVarContext.getTypeVarType(typeVar);

            // Is this one of the synthesized type vars we allocated above? If so,
            // the type arg that corresponds to this type var maps back to the target type.
            if (
                synthTypeVar &&
                isTypeVar(synthTypeVar) &&
                synthTypeVar.details.isSynthesized &&
                synthTypeVar.details.synthesizedIndex !== undefined
            ) {
                const targetTypeVar =
                    ClassType.getTypeParameters(specializedType)[synthTypeVar.details.synthesizedIndex];
                if (index < expectedTypeArgs.length) {
                    let expectedTypeArgValue: Type | undefined = expectedTypeArgs[index];

                    if (liveTypeVarScopes) {
                        expectedTypeArgValue = transformExpectedTypeForConstructor(
                            expectedTypeArgValue,
                            typeVarContext,
                            liveTypeVarScopes
                        );
                    }

                    if (expectedTypeArgValue) {
                        typeVarContext.setTypeVarType(
                            targetTypeVar,
                            TypeVarType.getVariance(typeVar) === Variance.Covariant ? undefined : expectedTypeArgValue,
                            TypeVarType.getVariance(typeVar) === Variance.Contravariant
                                ? undefined
                                : expectedTypeArgValue
                        );
                    } else {
                        isResultValid = false;
                    }
                }
            }
        });

        return isResultValid;
    }

    return false;
}
