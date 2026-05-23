/**
 * @module components/forms/Form
 *
 * Typed wrapper around react-hook-form's `useForm` + `FormProvider`.
 * The `<Form>` component composes:
 *
 *   1. `useForm({ resolver: zodResolver(schema) })` — schema-driven
 *      validation
 *   2. `FormProvider` — so `<FormField>` can read context without prop
 *      drilling
 *   3. A `<form>` element with `onSubmit` wired to `handleSubmit`
 *
 * Phase 4 / STR-115.
 */

import { type ReactNode } from 'react';
import {
  type DefaultValues,
  type FieldValues,
  FormProvider,
  type SubmitHandler,
  useForm,
  type UseFormReturn,
} from 'react-hook-form';
import type { ZodType } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

export interface FormProps<TValues extends FieldValues> {
  /** Zod schema driving validation + types. */
  readonly schema: ZodType<TValues>;
  /** Default values for the form. */
  readonly defaultValues?: DefaultValues<TValues>;
  /** Submit handler — receives parsed + typed values. */
  readonly onSubmit: SubmitHandler<TValues>;
  /** Children get access to FormProvider context via `useFormContext`. */
  readonly children: ReactNode | ((methods: UseFormReturn<TValues>) => ReactNode);
  /** Standard form attributes. */
  readonly className?: string;
  readonly id?: string;
  readonly noValidate?: boolean;
}

export function Form<TValues extends FieldValues>({
  schema,
  defaultValues,
  onSubmit,
  children,
  className,
  id,
  noValidate = true,
}: FormProps<TValues>) {
  const methods = useForm<TValues>({
    // zodResolver's generic isn't perfectly aligned with react-hook-form's
    // Resolver type for arbitrary value shapes; cast at the boundary.
    resolver: zodResolver(schema as never) as never,
    defaultValues,
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  return (
    <FormProvider {...methods}>
      <form
        id={id}
        className={className}
        noValidate={noValidate}
        onSubmit={methods.handleSubmit(onSubmit)}
      >
        {typeof children === 'function' ? children(methods) : children}
      </form>
    </FormProvider>
  );
}
