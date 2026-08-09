/**
 * The pixel size of an encoded image, read from its header.
 *
 * Barcode positions come back in pixels of whatever was decoded, and cutting a sheet into
 * one region per ticket needs them as fractions of the page — which needs the size of the
 * image they were measured against. Decoding the whole bitmap to learn its width would mean
 * pulling in an image library, and a rasterizer is free to hand back either format, so both
 * headers are read here instead.
 *
 * Neither parser validates the file. Anything unrecognised returns `undefined`, and the
 * caller falls back to not cutting the page at all rather than cutting it wrongly.
 */
export interface ImageSize {
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  )
}

function readUint16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  // Signature, then the IHDR chunk, whose first two fields are the dimensions. IHDR is
  // required by the format to come first, so the offsets are fixed.
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return undefined
  }
  const width = readUint32(bytes, 16)
  const height = readUint32(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** The frame headers that carry the dimensions. C4, C8 and CC share the range and do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined
  }
  let at = 2
  while (at + 3 < bytes.length) {
    // Fill bytes are legal between segments, so skip any run of 0xFF down to the marker.
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Standalone markers carry no length, and the entropy-coded data after SOS is not
    // worth walking: the frame header always precedes it.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }
    if (marker === 0xda) {
      return undefined
    }
    const length = readUint16(bytes, at + 2)
    if (length < 2) {
      return undefined
    }
    if (isStartOfFrame(marker) && at + 9 < bytes.length) {
      const height = readUint16(bytes, at + 5)
      const width = readUint16(bytes, at + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    at += 2 + length
  }
  return undefined
}

export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes)
}
