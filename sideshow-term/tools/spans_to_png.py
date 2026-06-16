#!/usr/bin/env python3
"""Rasterize captured opentui spans (JSON from capture-spans.ts) to a PNG.

Paints a faithful terminal-style image: a monospaced grid with per-cell
foreground/background colors and bold/italic/underline/dim/strike styling.
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
SIZE = 22
PAD = SIZE  # margin around the grid

BOLD, DIM, ITALIC, UNDERLINE, STRIKE = 1, 2, 4, 8, 128

fonts = {
    (False, False): ImageFont.truetype(f"{FONT_DIR}/DejaVuSansMono.ttf", SIZE),
    (True, False): ImageFont.truetype(f"{FONT_DIR}/DejaVuSansMono-Bold.ttf", SIZE),
    (False, True): ImageFont.truetype(f"{FONT_DIR}/DejaVuSansMono-Oblique.ttf", SIZE),
    (True, True): ImageFont.truetype(f"{FONT_DIR}/DejaVuSansMono-BoldOblique.ttf", SIZE),
}

# Cell metrics from the regular face.
base = fonts[(False, False)]
ascent, descent = base.getmetrics()
CELL_W = round(base.getlength("M"))
CELL_H = ascent + descent


def blend(fg, bg, t):
    return tuple(round(fg[i] * (1 - t) + bg[i] * t) for i in range(3))


def main():
    data = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    cols, rows = data["cols"], data["rows"]
    term_bg = tuple(data["bg"][:3])

    W = cols * CELL_W + 2 * PAD
    H = rows * CELL_H + 2 * PAD
    img = Image.new("RGB", (W, H), term_bg)
    draw = ImageDraw.Draw(img)

    for r, line in enumerate(data["lines"]):
        y = PAD + r * CELL_H
        col = 0
        for span in line["spans"]:
            attrs = span["attributes"]
            bold, italic = bool(attrs & BOLD), bool(attrs & ITALIC)
            font = fonts[(bold, italic)]
            fg = tuple(span["fg"][:3])
            sbg = span["bg"]
            has_bg = len(sbg) > 3 and sbg[3] > 0
            if attrs & DIM:
                fg = blend(fg, term_bg, 0.45)
            # Each character occupies one fixed-width cell.
            for ch in span["text"]:
                x = PAD + col * CELL_W
                if has_bg:
                    draw.rectangle([x, y, x + CELL_W, y + CELL_H], fill=tuple(sbg[:3]))
                if ch != " ":
                    draw.text((x, y), ch, font=font, fill=fg)
                if attrs & UNDERLINE:
                    draw.line([x, y + ascent + 1, x + CELL_W, y + ascent + 1], fill=fg, width=1)
                if attrs & STRIKE:
                    my = y + ascent // 2
                    draw.line([x, my, x + CELL_W, my], fill=fg, width=1)
                col += 1

    img.save(out)
    print(f"wrote {out} ({W}x{H})")


if __name__ == "__main__":
    main()
