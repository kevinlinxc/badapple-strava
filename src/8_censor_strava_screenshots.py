# censor my name and location information from screenshots of strava
"""
Usage:
    python 8_censor_strava_screenshots.py <folder>
    python 8_censor_strava_screenshots.py --file <image.jpg>

Processes all .jpg files in <folder> and outputs censored versions
with "-censored" appended before .jpg in the same folder.
Use --file to process a single image instead.

Dependencies:
    pip install pillow pytesseract
    # Also requires Tesseract OCR installed on your system:
    #   macOS:  brew install tesseract
    #   Ubuntu: sudo apt install tesseract-ocr
    #   Windows: https://github.com/UB-Mannheim/tesseract/wiki
"""

import sys
import re
import time
import tempfile
import logging
from pathlib import Path
from PIL import Image, ImageDraw
import pytesseract


logger = logging.getLogger("censor")


def setup_logger(log_path: str):
    """Send logs to both console (INFO+) and a file (DEBUG+)."""
    logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(log_path)
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(fh)
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(ch)


# ---------------------------------------------------------------------------
# Configuration — edit these to taste
# ---------------------------------------------------------------------------

# Padding (px) to add around each detected bounding box
BOX_PADDING = 4
# cuesta_drive gets more horizontal padding and less vertical padding
DRIVE_PAD_X = BOX_PADDING + 5   # left/right
DRIVE_PAD_Y = BOX_PADDING - 2   # top/bottom

# How much extra image height (as a fraction) to crop above and below
# a "Congrats" banner before re-running censoring on the cropped image.
CONGRATS_CROP_MARGIN = 0.05

# Colors for each category of redaction
COLORS = {
    "last_name":       (20,   20,   20), # strava header background colour
    "location":        (20,   20,   20), # same
    "cuesta_drive":    (73,  80,  88),   # road color
    "cuesta_park":     (57,  62, 68),   # parking lot color
}

# What to search for (lowercased for matching)
# Each entry: (category_key, list_of_consecutive_words_that_form_the_phrase)
PHRASES = [
    ("last_name",    ["lin"]),
    ("location",     ["mountain", "view,"]), 
    ("location",     ["california"]),
    ("cuesta_drive", ["cuesta", "drive"]),
    ("cuesta_park",  ["cuesta", "park"]),
]

# Zones (as fractions of image height) where map labels can appear.
# If OCR detects any token in these zones we redact it — nothing else
# appears on the teal map background.
#
#   40–70% of image height → assume Cuesta Drive label
#   70–92% of image height → assume Cuesta (park label)
#
ZONE_DRIVE = (0.4, 0.65)
ZONE_PARK  = (0.65, 0.92)


# ---------------------------------------------------------------------------


def get_word_boxes(image: Image.Image) -> list[dict]:
    """Run Tesseract and return a list of word dicts with bounding info."""
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, config="--psm 11")
    boxes = []
    n = len(data["text"])
    for i in range(n):
        word = data["text"][i].strip()
        if not word:
            continue
        boxes.append(
            {
                "word":  word,
                "lower": word.lower(),
                "x":     data["left"][i],
                "y":     data["top"][i],
                "w":     data["width"][i],
                "h":     data["height"][i],
                "conf":  data["conf"][i],
            }
        )
    return boxes


# Words that indicate a Strava milestone/achievement banner.
# Any token starting with one of these triggers a crop.
BANNER_TRIGGER_WORDS = {"congrats", "kudos", "streak", "more"}


def find_banner_row(boxes: list[dict], img_h: int) -> tuple[int, int] | None:
    """
    Look for a Strava milestone banner (e.g. "Congrats on your 50th activity!",
    "Kudos on your 100th activity!") by checking if any token starts with a
    known trigger word. When found, returns (crop_top, crop_bottom) spanning
    the full vertical extent of all tokens on the same approximate row, plus
    CONGRATS_CROP_MARGIN padding. Returns None if no banner is detected.
    """
    # Find the anchor token
    anchor = None
    for b in boxes:
        if any(b["lower"].startswith(t) for t in BANNER_TRIGGER_WORDS):
            anchor = b
            break
    if anchor is None:
        return None

    # Collect all tokens whose vertical midpoint is within the anchor's row
    # (within one anchor-height above/below its centre) to get the full extent.
    anchor_mid = anchor["y"] + anchor["h"] / 2
    row_tokens = [
        b for b in boxes
        if abs((b["y"] + b["h"] / 2) - anchor_mid) < anchor["h"]
    ]
    row_top    = min(b["y"]          for b in row_tokens)
    row_bottom = max(b["y"] + b["h"] for b in row_tokens)

    margin      = int(img_h * CONGRATS_CROP_MARGIN)
    crop_top    = max(0,     row_top    - margin)
    crop_bottom = min(img_h, row_bottom + margin)
    return (crop_top, crop_bottom)


def find_frame_number(boxes: list[dict]) -> str | None:
    """
    Look for the pattern "Frame <number>" in the OCR boxes and return the
    number as a string (e.g. "765"), or None if not found.
    """
    for i, b in enumerate(boxes):
        if b["lower"] == "frame" and i + 1 < len(boxes):
            candidate = boxes[i + 1]["word"]
            if candidate.isdigit():
                return candidate
    return 0


def find_phrase_boxes(
    boxes: list[dict],
    phrase_words: list[str],
) -> list[tuple[int, int, int, int]]:
    """
    Search `boxes` for consecutive occurrences of `phrase_words`.
    Returns a list of (x1, y1, x2, y2) bounding rectangles (one per match).
    Matching is done on lowercased text using substring containment, so
    "uesta\\Park" (OCR clip artefact) still matches target word "cuesta".
    """
    matches = []
    pw = [w.lower() for w in phrase_words]
    n = len(boxes)
    m = len(pw)

    for i in range(n - m + 1):
        hit = True
        for j in range(m):
            b_lower = boxes[i + j]["lower"]
            # Primary match: OCR token equals the target word exactly.
            # Fallback: for map-label words that may be clipped at the image
            # edge (e.g. "uesta\Park" for "cuesta"), also accept when the
            # target word ends with whatever alphabetic prefix the OCR token
            # starts with (i.e. the token is a clipped suffix of the target).
            b_alpha_start = re.match(r'^[a-z]+', b_lower)
            b_start = b_alpha_start.group() if b_alpha_start else ""
            exact_match   = (b_lower == pw[j])
            clipped_match = (len(b_start) >= 3 and pw[j].endswith(b_start) and b_lower.startswith(b_start))
            if not (exact_match or clipped_match):
                hit = False
                break
        if hit:
            matched = boxes[i : i + m]
            x1 = min(b["x"] for b in matched)
            y1 = min(b["y"] for b in matched)
            y2 = max(b["y"] + b["h"] for b in matched)

            # For the last token in the match, check if it was a clipped match
            # (e.g. "uesta\Park" matched target "cuesta"). If so, only cover the
            # portion of the token that corresponds to the matched prefix chars,
            # not the full token width (which would also cover "Park").
            last_box = matched[-1]
            last_lower = last_box["lower"]
            last_target = pw[-1]
            b_alpha_start = re.match(r'^[a-z]+', last_lower)
            b_start = b_alpha_start.group() if b_alpha_start else ""
            is_clipped = (last_lower != last_target and
                          len(b_start) >= 3 and last_target.endswith(b_start))
            if is_clipped:
                # Estimate x2 by the fraction: len(matched_prefix) / len(full_token_alpha)
                full_alpha = re.sub(r'[^a-z]', '', last_lower)
                frac = len(b_start) / max(len(full_alpha), 1)
                x2 = last_box["x"] + int(last_box["w"] * frac)
            else:
                x2 = max(b["x"] + b["w"] for b in matched)

            matches.append((x1, y1, x2, y2))
    return matches


def find_zone_boxes(
    boxes: list[dict],
    img_h: int,
) -> list[tuple[tuple[int, int, int, int], str]]:
    """
    Fallback pass: redact any OCR token whose vertical midpoint falls inside
    a map zone. Nothing else appears on the teal map background, so any token
    detected there must be a (possibly partial) label we want to censor.

    Returns a list of ((x1, y1, x2, y2), category) tuples.
    """
    results = []
    for b in boxes:
        # Skip garbage tokens that are unrealistically tall (vertical UI lines etc.)
        if b["h"] > 100:
            continue
        mid_y = (b["y"] + b["h"] / 2) / img_h

        if ZONE_DRIVE[0] <= mid_y <= ZONE_DRIVE[1]:
            results.append(((b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]), "cuesta_drive"))
            logger.info("  Zone drive fallback '%s' [cuesta_drive] midY=%.2f", b["word"], mid_y)
        elif ZONE_PARK[0] <= mid_y <= ZONE_PARK[1]:
            results.append(((b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]), "cuesta_park"))
            logger.info("  Zone park fallback '%s' [cuesta_park]  midY=%.2f", b["word"], mid_y)

    return results


def cap_right_at_color(img, x1, y1, x2, y2):
    """
    Scan columns from left to right; return the first column x that contains
    a pixel matching green #2d544f (40 px above the box to avoid the park text) or orange #e05f2f
    (within the box). If none found, return x2 unchanged.
    """
    GREEN = (45, 84, 79)
    GREEN_TOL = 40
    GREEN_Y1 = int(y1) - 40
    GREEN_Y2 = int(y2) - 40

    ORANGE = (224, 95, 47)
    ORANGE_TOL = 40
    ORANGE_Y1 = int(y1)
    ORANGE_Y2 = int(y2)

    STRIDE = 4
    img_w = img.size[0]
    img_h = img.size[1]
    pixels = img.load()
    x2 = min(int(x2), img_w - 1)

    for x in range(int(x1), x2 + 1):
        # green: scan 40 px above the box
        for y in range(max(0, GREEN_Y1), min(img_h, GREEN_Y2), STRIDE):
            r, g, b = pixels[x, y]
            if (abs(r - GREEN[0]) <= GREEN_TOL and
                abs(g - GREEN[1]) <= GREEN_TOL and
                abs(b - GREEN[2]) <= GREEN_TOL and
                g > r * 1.2):                   # park green has G >> R; teal bg has G ≈ R
                return x
        # orange: scan within the box
        for y in range(max(0, ORANGE_Y1), min(img_h, ORANGE_Y2), STRIDE):
            r, g, b = pixels[x, y]
            if (abs(r - ORANGE[0]) <= ORANGE_TOL and
                abs(g - ORANGE[1]) <= ORANGE_TOL and
                abs(b - ORANGE[2]) <= ORANGE_TOL and
                r > g * 1.5 and r > b * 1.5):   # orange has R dominating both G and B
                return x
    return x2


def show_side_by_side(original: Image.Image, censored: Image.Image, name: str):
    """Show original and censored images side by side for ~1 second."""
    w, h = original.size
    combined = Image.new("RGB", (w * 2, h))
    combined.paste(original, (0, 0))
    combined.paste(censored, (w, 0))
    combined.show(title=f"{name} — Original | Censored")
    time.sleep(1)
    combined.close()


def censor_image(input_path: str, output_path: str | None = None, _frame: str | None = None) -> str:
    """
    Load the image at `input_path`, run OCR, draw redaction rectangles,
    show a side-by-side preview, and save the result. Returns the output path.

    Output is written to a 'censored/' subfolder next to the source folder,
    named 'strava-screenshot-<frame>-censored.jpg' when a Bad Apple frame
    number is found, or '<original_stem>-censored.jpg' as a fallback.

    If a milestone banner is detected ("Congrats", "Kudos", etc.), the banner
    row is cropped out and this function recurses once on the cropped image so
    that zone fractions stay correct for the trimmed layout.
    """
    input_path = Path(input_path)

    logger.info("Loading: %s", input_path)
    original = Image.open(input_path).convert("RGB")
    img_w, img_h = original.size
    boxes = get_word_boxes(original)
    logger.info("  %d words detected", len(boxes))

    # Extract frame number on the first (non-recursive) call
    if _frame is None:
        _frame = find_frame_number(boxes)
        if _frame is not None:
            logger.info("  Bad Apple frame: %s", _frame)
        else:
            logger.info("  Bad Apple frame: not found, using original filename")

    # --- Resolve output path early so recursion always has it explicit ---
    if output_path is None:
        stem = f"strava-screenshot-{_frame}" if _frame is not None else input_path.stem
        # If input_path is a tempfile, we won't have the real folder — but
        # output_path is always passed explicitly in the recursive call, so
        # this branch only runs on the first call where input_path is real.
        out_dir = input_path.parent / "censored"
        out_dir.mkdir(exist_ok=True)
        output_path = str(out_dir / f"{stem}-censored.jpg")

    # --- Milestone banner: crop it out and recurse ---
    banner_row = find_banner_row(boxes, img_h)
    if banner_row is not None:
        crop_top, crop_bottom = banner_row
        logger.info("  Milestone banner detected — cropping rows %d–%d and re-running", crop_top, crop_bottom)
        top_half    = original.crop((0, 0,           img_w, crop_top))
        bottom_half = original.crop((0, crop_bottom, img_w, img_h))
        new_h = top_half.height + bottom_half.height
        stitched = Image.new("RGB", (img_w, new_h))
        stitched.paste(top_half,    (0, 0))
        stitched.paste(bottom_half, (0, top_half.height))
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
        stitched.save(tmp_path, quality=95)
        return censor_image(tmp_path, output_path, _frame=_frame)

    output_path = Path(output_path)

    censored = original.copy()
    draw = ImageDraw.Draw(censored)

    redactions: list[tuple[tuple[int,int,int,int], str]] = []  # (rect, category)

    # --- Primary pass: exact / clipped phrase matching ---
    already_redacted: set[tuple[int,int,int,int]] = set()
    for category, phrase_words in PHRASES:
        hits = find_phrase_boxes(boxes, phrase_words)
        for (x1, y1, x2, y2) in hits:
            px = DRIVE_PAD_X if category == "cuesta_drive" else BOX_PADDING
            py = DRIVE_PAD_Y if category == "cuesta_drive" else BOX_PADDING
            rx1 = max(0, x1 - px)
            ry1 = max(0, y1 - py)
            rx2 = min(img_w, x2 + px)
            ry2 = min(img_h, y2 + py)
            if category == "cuesta_park":
                rx2 = cap_right_at_color(original, rx1, ry1, rx2, ry2)
                logger.info("  Capped cuesta_park right edge to x2=%d", rx2)
            rect = (rx1, ry1, rx2, ry2)
            redactions.append((rect, category))
            already_redacted.add(rect)
            logger.info("  Redacting '%s' [%s] @ (%d,%d)-(%d,%d)",
                        " ".join(phrase_words), category, rx1, ry1, rx2, ry2)

    # --- Fallback pass: zone-based partial matching ---
    for (x1, y1, x2, y2), category in find_zone_boxes(boxes, img_h):
        px = DRIVE_PAD_X if category == "cuesta_drive" else BOX_PADDING
        py = DRIVE_PAD_Y if category == "cuesta_drive" else BOX_PADDING
        rx1 = max(0, x1 - px)
        ry1 = max(0, y1 - py)
        rx2 = min(img_w, x2 + px)
        ry2 = min(img_h, y2 + py)
        if category == "cuesta_park":
            rx2 = cap_right_at_color(original, rx1, ry1, rx2, ry2)
            logger.info("  Zone fallback capped cuesta_park right edge to x2=%d", rx2)
        rect = (rx1, ry1, rx2, ry2)
        if rect not in already_redacted:   # skip if primary pass already covered it
            redactions.append((rect, category))

    if not redactions:
        logger.warning("  WARNING: no phrases matched — output will be unchanged.")

    for rect, category in redactions:
        color = COLORS[category]
        draw.rectangle(rect, fill=color)

    # show_side_by_side(original, censored, input_path.stem)

    censored.save(output_path, quality=95)
    logger.info("Saved:  %s", output_path)
    return str(output_path)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--file":
        if len(sys.argv) < 3:
            print("Error: --file requires a path to an image")
            sys.exit(1)
        file_path = Path(sys.argv[2])
        if not file_path.is_file():
            print(f"Error: '{file_path}' not found")
            sys.exit(1)
        setup_logger(str(file_path.with_name("censor.log")))
        censor_image(str(file_path))
        sys.exit(0)

    folder = Path(sys.argv[1])
    if not folder.is_dir():
        print(f"Error: '{folder}' is not a directory")
        sys.exit(1)

    # Wipe and recreate the censored subfolder for a clean run
    censored_dir = folder / "censored"
    if censored_dir.exists():
        for old in censored_dir.glob("*"):
            old.unlink()
    censored_dir.mkdir(exist_ok=True)
    setup_logger(str(censored_dir / "censor.log"))

    jpg_files = sorted(f for f in folder.glob("*.jpg") if "censored" not in f.name)
    if not jpg_files:
        logger.error("No .jpg files found in '%s'", folder)
        sys.exit(0)

    logger.info("Found %d .jpg file(s) in '%s'", len(jpg_files), folder)
    for jpg in jpg_files:
        censor_image(str(jpg))