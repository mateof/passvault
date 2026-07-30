/**
 * Associated data strings.
 *
 * Every encrypted part is bound to its role and to the file it belongs to. Without
 * the role, a blob could be presented as the payload; without the file id, a part
 * could be lifted from one file into another. Both would survive decryption if the
 * signature were never checked, which is exactly the case a reader must not depend
 * on getting right.
 */
export const filekeyAad = (fileId: string): string => `tkpak/v1/filekey:${fileId}`

export const payloadAad = (fileId: string): string => `tkpak/v1/payload:${fileId}`

export const blobAad = (fileId: string, blobId: string): string =>
  `tkpak/v1/blob:${fileId}:${blobId}`

export const MANIFEST_SIGNING_DOMAIN = 'tkpak/v1/manifest'
