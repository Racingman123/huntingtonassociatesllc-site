/** bcrypt only consumes the first 72 UTF-8 bytes of a password. */
export function fitsBcryptInput(password: string) {
  return new TextEncoder().encode(password).byteLength <= 72;
}
