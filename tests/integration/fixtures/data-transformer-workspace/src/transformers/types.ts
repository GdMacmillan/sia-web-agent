/**
 * Shared types for all transformers
 */

/**
 * Result of validating data
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Generic transformer interface
 * All transformers must implement this pattern
 */
export interface Transformer<T, S = string> {
  /**
   * Convert from serialized format to typed object
   */
  from(serialized: S): T;

  /**
   * Convert from typed object to serialized format
   */
  to(data: T): S;

  /**
   * Validate that data conforms to expected type
   */
  validate(data: unknown): ValidationResult;
}
