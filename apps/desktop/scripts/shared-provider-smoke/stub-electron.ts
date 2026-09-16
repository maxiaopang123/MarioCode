let available = true;
export function setEncryptionAvailable(value: boolean): void { available = value; }
export const safeStorage = {
  isEncryptionAvailable: (): boolean => available,
  encryptString: (value: string): Buffer => Buffer.from(`cipher:${value}`, "utf8"),
  decryptString: (value: Buffer): string => {
    const decrypted = value.toString("utf8");
    if (!decrypted.startsWith("cipher:")) throw new Error("Unable to decrypt test ciphertext");
    return decrypted.slice("cipher:".length);
  },
};
