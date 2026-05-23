/**
 * @module components/forms/FormField
 *
 * Field-level wrapper for form inputs. Composes a label, an input slot
 * (via Radix `<Slot>` for polymorphism — the caller passes any input
 * element and we wire it through), help text, and an error.
 *
 * Wires automatically to the parent `<Form>`'s react-hook-form context
 * by `name`. Reads the validation error from `formState.errors[name]`
 * and renders it via `<FormError>`.
 *
 * Phase 4 / STR-115.
 *
 * Usage:
 * ```tsx
 * <FormField name="recipient" label="Recipient party">
 *   <input className="input" placeholder="Alice::abc123" />
 * </FormField>
 * ```
 */

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import { Slot } from '@radix-ui/react-slot';
import { FormError } from './FormError.js';

export interface FormFieldProps {
  /**
   * Field name — must match a key on the form's schema. The matching
   * react-hook-form `register(name)` props are spread onto the child
   * input automatically.
   */
  readonly name: string;
  readonly label?: ReactNode;
  /** Required-indicator next to the label. Cosmetic; validation is schema-driven. */
  readonly required?: boolean;
  /** Help text below the input; hidden when an error is showing. */
  readonly help?: ReactNode;
  /** Exactly one input element as child. Slot will inject register() props. */
  readonly children: ReactElement;
  readonly className?: string;
  /**
   * Forces the field into error state with the given message even when
   * react-hook-form hasn't surfaced one yet (used by parent components
   * that need to project async/cross-field errors here).
   */
  readonly errorOverride?: string;
}

export function FormField({
  name,
  label,
  required,
  help,
  children,
  className,
  errorOverride,
}: FormFieldProps) {
  const { register, formState } = useFormContext();

  const child = Children.only(children);
  if (!isValidElement(child)) {
    throw new Error('<FormField> requires a single React element child');
  }

  const registerProps = register(name);

  // Slot pattern: clone the child once with the register() props applied.
  // Slot itself handles ref-forwarding for polymorphic usage; the
  // cloneElement is the simple shape that works for native <input>,
  // <select>, <textarea>, and any forwardRef'd custom input.
  const wiredChild = cloneElement(child, {
    ...registerProps,
    id: (child.props as { id?: string }).id ?? name,
    'aria-invalid': (formState.errors[name] || errorOverride) ? true : undefined,
    'aria-describedby': (formState.errors[name] || errorOverride) ? `${name}-error` : undefined,
  } as never);

  const error = errorOverride ?? (formState.errors[name]?.message as string | undefined);

  return (
    <div className={className ?? 'mb-3'}>
      {label !== undefined && (
        <label
          htmlFor={name}
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </label>
      )}
      <Slot>{wiredChild}</Slot>
      {error ? (
        <FormError id={`${name}-error`}>{error}</FormError>
      ) : help ? (
        <p className="mt-1 text-xs text-gray-500">{help}</p>
      ) : null}
    </div>
  );
}
