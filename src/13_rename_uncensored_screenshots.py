# rename uncensored strava screenshots to badapple-strava-<frame>.jpg using OCR, for the final video
"""
Usage:
    python 13_rename_uncensored_screenshots.py [folder] [--dry-run]
    python 13_rename_uncensored_screenshots.py [folder] --remove-celebrations [--dry-run]

OCRs every .jpg in <folder> (default: strava_data/screenshots/uncensored),
reads the "Bad Apple Frame <number>" title and renames the file in place to
badapple-strava-<frame>.jpg (frame zero-padded to 4 digits). Nothing is censored.

- Files already named badapple-strava-<frame>.jpg are not touched or OCR'd.
- Screenshots whose date reads "Yesterday" or "Today" are reported and left alone,
  since they need to be retaken once Strava shows the real date.
- Duplicates of a frame are reported and left alone (first one wins).
- At the end, reports which expected frames still have no screenshot.

Use --dry-run to see what would happen without renaming anything.

With --remove-celebrations, nothing is renamed. Instead every already-named
screenshot is checked for a Strava milestone banner ("Congrats on your 50th
activity!", kudos, streaks, ...), the same way 8_censor_strava_screenshots.py
does. The banner row is cut out and the rest stitched back together, and the
result is saved under the same name in <folder>/uncensored-removed. Screenshots
without a banner are copied there as-is, so the subfolder holds the full set.
Originals are left alone.

Dependencies:
    pip install pillow pytesseract
    # Also requires Tesseract OCR installed on your system:
    #   macOS:  brew install tesseract
"""

import sys
import re
import shutil
from pathlib import Path
from PIL import Image
import pytesseract


DEFAULT_FOLDER = Path(__file__).parent.parent / "strava_data" / "screenshots" / "uncensored"

# Every 15th frame was done up to 1980, then every 30th frame until the end
EXPECTED_FRAMES = sorted(set(range(0, 1981, 15)) | set(range(2010, 6571, 30)))

# Screenshots where OCR can't read the frame number, filename -> frame
FRAME_OVERRIDES = {
    "IMG_7740.jpg": 0,
    "IMG_7831.jpg": 1335,  # OCR reads 13355
}

REMOVED_SUBFOLDER = "uncensored-removed"

# Words that indicate a Strava milestone/achievement banner.
# Any token starting with one of these triggers a crop.
# "nicely"/"challenge" cover the two-line "Nicely done! Keep moving by joining a challenge" banner.
BANNER_TRIGGER_WORDS = {"congrats", "kudos", "streak", "more", "nicely", "challenge"}

# How much extra image height (as a fraction) to crop above and below a banner
CONGRATS_CROP_MARGIN = 0.05

DONE_PATTERN = re.compile(r"^badapple-strava-(\d{4})\.jpg$")
FRAME_PATTERN = re.compile(r"frame\s+(\d+)", re.IGNORECASE)
RELATIVE_DATE_PATTERN = re.compile(r"\b(yesterday|today)\b", re.IGNORECASE)


def target_name(frame: int) -> str:
    return f"badapple-strava-{frame:04d}.jpg"


def ocr_text(path: Path) -> str:
    with Image.open(path) as image:
        return pytesseract.image_to_string(image.convert("RGB"), config="--psm 11")


def get_word_boxes(image: Image.Image) -> list[dict]:
    """Run Tesseract and return a list of word dicts with bounding info."""
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, config="--psm 11")
    boxes = []
    for i in range(len(data["text"])):
        word = data["text"][i].strip()
        if not word:
            continue
        boxes.append(
            {
                "word":  word,
                "lower": word.lower(),
                "y":     data["top"][i],
                "h":     data["height"][i],
            }
        )
    return boxes


def find_banner_row(boxes: list[dict], img_h: int) -> tuple[int, int, str] | None:
    """
    Look for a milestone banner by checking if any token starts with a known
    trigger word. Returns (crop_top, crop_bottom, row_text) spanning all tokens
    on the same approximate row as a trigger word (a banner can wrap onto two
    lines) plus CONGRATS_CROP_MARGIN padding, or None.
    """
    anchors = [
        b for b in boxes
        if any(b["lower"].startswith(t) for t in BANNER_TRIGGER_WORDS)
    ]
    if not anchors:
        return None

    row_tokens = [
        b for b in boxes
        if any(
            abs((b["y"] + b["h"] / 2) - (a["y"] + a["h"] / 2)) < a["h"]
            for a in anchors
        )
    ]
    row_top    = min(b["y"]          for b in row_tokens)
    row_bottom = max(b["y"] + b["h"] for b in row_tokens)

    margin      = int(img_h * CONGRATS_CROP_MARGIN)
    crop_top    = max(0,     row_top    - margin)
    crop_bottom = min(img_h, row_bottom + margin)
    return (crop_top, crop_bottom, " ".join(b["word"] for b in row_tokens))


def remove_celebrations(image: Image.Image) -> tuple[Image.Image, list[str]]:
    """Cut every banner row out of the image. Returns (image, text of each removed banner)."""
    removed = []
    # re-OCR after each cut, a screenshot can stack more than one banner
    for _ in range(5):
        img_w, img_h = image.size
        banner_row = find_banner_row(get_word_boxes(image), img_h)
        if banner_row is None:
            break
        crop_top, crop_bottom, row_text = banner_row
        top_half    = image.crop((0, 0,           img_w, crop_top))
        bottom_half = image.crop((0, crop_bottom, img_w, img_h))
        stitched = Image.new("RGB", (img_w, top_half.height + bottom_half.height))
        stitched.paste(top_half,    (0, 0))
        stitched.paste(bottom_half, (0, top_half.height))
        image = stitched
        removed.append(row_text)
    return image, removed


def run_remove_celebrations(folder: Path, dry_run: bool):
    files = sorted(f for f in folder.glob("*.jpg") if DONE_PATTERN.match(f.name))
    out_dir = folder / REMOVED_SUBFOLDER
    print(f"Checking {len(files)} named screenshot(s) in '{folder}' for celebrations")
    if dry_run:
        print("(dry run, nothing will be saved)")
    else:
        out_dir.mkdir(exist_ok=True)

    cleaned = []
    for i, f in enumerate(files, 1):
        with Image.open(f) as opened:
            # iPhone screenshots are Display P3, keep the profile or the colors shift
            icc_profile = opened.info.get("icc_profile")
            image, removed = remove_celebrations(opened.convert("RGB"))
        if not removed:
            if not dry_run:
                shutil.copy2(f, out_dir / f.name)
            print(f"[{i}/{len(files)}] {f.name}: no celebration, copied")
            continue
        if not dry_run:
            image.save(out_dir / f.name, quality=95, icc_profile=icc_profile)
        label = " + ".join(f"'{text}'" for text in removed)
        print(f"[{i}/{len(files)}] {f.name}: removed {label}")
        cleaned.append(f"{f.name}  ({label})")

    print("\n" + "=" * 60)
    print_section("Celebrations removed", cleaned)
    if not cleaned:
        print("No celebrations found")
    print(f"\n{'Would save' if dry_run else 'Saved'} {len(files)} screenshot(s) to {out_dir}")


def frame_ranges(frames: list[int]) -> list[str]:
    """Collapse frames into runs that are consecutive in EXPECTED_FRAMES, e.g. '2460-2760 (11)'."""
    runs = []
    for frame in frames:
        idx = EXPECTED_FRAMES.index(frame)
        if runs and runs[-1][-1] == idx - 1:
            runs[-1].append(idx)
        else:
            runs.append([idx])
    return [
        str(EXPECTED_FRAMES[run[0]]) if len(run) == 1
        else f"{EXPECTED_FRAMES[run[0]]}-{EXPECTED_FRAMES[run[-1]]} ({len(run)})"
        for run in runs
    ]


def print_section(title: str, lines: list[str]):
    if not lines:
        return
    print(f"\n{title} ({len(lines)}):")
    for line in lines:
        print(f"  {line}")


if __name__ == "__main__":
    flags = {"--dry-run", "--remove-celebrations"}
    args = [a for a in sys.argv[1:] if a not in flags]
    dry_run = "--dry-run" in sys.argv[1:]

    folder = Path(args[0]) if args else DEFAULT_FOLDER
    if not folder.is_dir():
        print(f"Error: '{folder}' is not a directory")
        sys.exit(1)

    if "--remove-celebrations" in sys.argv[1:]:
        run_remove_celebrations(folder, dry_run)
        sys.exit(0)

    # frame -> filename that holds it, starting with the files that are already done
    have: dict[int, str] = {}
    todo = []
    for f in sorted(folder.glob("*.jpg")):
        match = DONE_PATTERN.match(f.name)
        if match:
            have[int(match.group(1))] = f.name
        else:
            todo.append(f)

    print(f"{len(have)} already named, {len(todo)} to process in '{folder}'")
    if dry_run:
        print("(dry run, nothing will be renamed)")

    renamed = []
    relative_date = []
    no_frame = []
    unexpected = []
    duplicates = []

    for i, f in enumerate(todo, 1):
        text = ocr_text(f)
        frame_match = FRAME_PATTERN.search(text)
        date_match = RELATIVE_DATE_PATTERN.search(text)
        frame = int(frame_match.group(1)) if frame_match else None
        frame = FRAME_OVERRIDES.get(f.name, frame)
        frame_label = f"frame {frame}" if frame is not None else "frame unknown"

        if date_match:
            status = f"SKIP, says '{date_match.group(1)}' ({frame_label})"
            relative_date.append(f"{f.name}  ({frame_label}, says '{date_match.group(1)}')")
        elif frame is None:
            status = "SKIP, no frame number found"
            no_frame.append(f.name)
        elif frame not in EXPECTED_FRAMES:
            status = f"SKIP, frame {frame} is not an expected frame (OCR misread?)"
            unexpected.append(f"{f.name}  (read frame {frame})")
        elif frame in have:
            status = f"SKIP, frame {frame} already covered by {have[frame]}"
            duplicates.append(f"{f.name}  (frame {frame}, kept {have[frame]})")
        else:
            new_name = target_name(frame)
            if not dry_run:
                f.rename(f.with_name(new_name))
            have[frame] = new_name
            status = f"-> {new_name}"
            renamed.append(f"{f.name} -> {new_name}")

        print(f"[{i}/{len(todo)}] {f.name}: {status}")

    missing = [frame for frame in EXPECTED_FRAMES if frame not in have]

    print("\n" + "=" * 60)
    print(f"{'Would rename' if dry_run else 'Renamed'}: {len(renamed)}")
    print_section("Not converted, date says Yesterday/Today", relative_date)
    print_section("Not converted, no frame number found", no_frame)
    print_section("Not converted, unexpected frame number", unexpected)
    print_section("Not converted, duplicate frame", duplicates)
    print_section("Missing frame ranges", frame_ranges(missing))
    print(f"\n{len(have)}/{len(EXPECTED_FRAMES)} expected frames have a screenshot")
