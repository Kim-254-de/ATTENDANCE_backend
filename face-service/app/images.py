"""Turning a submitted image string into a pixel array, or refusing it."""

import base64
import binascii
import re

import cv2
import numpy as np

_DATA_URL = re.compile(r"^data:image/(jpeg|jpg|png|webp);base64,", re.IGNORECASE)


class ImageError(ValueError):
    """The image cannot be used. `code` is returned to the caller as-is."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def decode_image(value: str, max_bytes: int, max_side_px: int) -> np.ndarray:
    """A base64 string or data URL (what the portal's canvas produces) as a BGR array.

    EXIF orientation is applied by imdecode, so a portrait phone photo is upright.
    """
    raw_b64 = _DATA_URL.sub("", value.strip(), count=1)
    # Checked before decoding: base64 is 4/3 the size of what it encodes.
    if len(raw_b64) * 3 // 4 > max_bytes:
        raise ImageError("IMAGE_TOO_LARGE", f"Images must be under {max_bytes // 1000} KB.")
    try:
        data = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ImageError("INVALID_IMAGE", "The image is not valid base64.") from None

    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ImageError("INVALID_IMAGE", "The image could not be read. Send a JPEG, PNG or WebP.")

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > max_side_px:
        scale = max_side_px / longest
        image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    return image
