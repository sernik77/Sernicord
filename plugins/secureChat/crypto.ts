/*
 * Sernicord SecureChat — WebCrypto helpers
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const PREFIX = "SCRD1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): Uint8Array {
    const pad = "===".slice((s.length + 3) % 4);
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(normalized);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

export function isSecurePayload(content: string): boolean {
    return typeof content === "string" && content.startsWith(PREFIX);
}

export async function encryptText(plain: string, passphrase: string): Promise<string> {
    if (!passphrase) throw new Error("SecureChat passphrase is empty");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(plain)
    );
    return `${PREFIX}${b64encode(salt)}.${b64encode(iv)}.${b64encode(cipher)}`;
}

export async function decryptText(payload: string, passphrase: string): Promise<string> {
    if (!isSecurePayload(payload)) throw new Error("Not a SecureChat payload");
    if (!passphrase) throw new Error("SecureChat passphrase is empty");
    const body = payload.slice(PREFIX.length);
    const [saltB64, ivB64, cipherB64] = body.split(".");
    if (!saltB64 || !ivB64 || !cipherB64) throw new Error("Malformed SecureChat payload");
    const salt = b64decode(saltB64);
    const iv = b64decode(ivB64);
    const cipher = b64decode(cipherB64);
    const key = await deriveKey(passphrase, salt);
    const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        cipher
    );
    return decoder.decode(plain);
}

export { PREFIX };
