from pathlib import Path
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "defaults"
PAGE_W, PAGE_H = A4
INK = HexColor("#151512")
MUTED = HexColor("#6f6b62")
ACCENT = HexColor("#b85226")
PAPER = HexColor("#f7f4ec")
MARGIN = 58


ARTICLES = [
    {
        "filename": "study-one.pdf",
        "number": "01",
        "title": "The Shape of a Working Idea",
        "date": "15 August 2026",
        "abstract": "A short field note on how an uncertain observation becomes a durable object of work.",
        "sections": [
            ("Begin with friction", "A working idea rarely arrives as a finished statement. It starts as a repeated friction: a detail that refuses to disappear, a question that returns after the original context is gone. The first task is not to explain it. The first task is to preserve its outline without making it smaller."),
            ("Give it a boundary", "A boundary creates enough resistance for the idea to become visible. Name what is inside, what is outside, and what evidence would force the boundary to move. This is not a definition for all time. It is a temporary instrument for seeing the next decision."),
            ("Make the trace reversible", "Every transformation should leave a readable trace. Keep the rejected fragments, record the assumptions, and make each new form comparable with the previous one. Reversibility is not hesitation. It is the ability to learn without destroying the path that produced the lesson."),
        ],
        "closing": "The useful shape is not the most polished one. It is the smallest form that can survive contact with reality and still tell us how it changed.",
    },
    {
        "filename": "study-two.pdf",
        "number": "02",
        "title": "Notes on Reversible Systems",
        "date": "05 August 2026",
        "abstract": "An operational sketch for systems that can be inspected, changed and restored without losing their history.",
        "sections": [
            ("State before action", "A reversible system makes its current state legible before it permits mutation. The operator should know what will change, which records will be affected, and what artifact will be available if the action fails."),
            ("Backups are arguments", "A backup is not proof of recovery. It is only a claim until a clean system can read it, verify it and restore the intended logical state. The recovery procedure is part of the data format, not an appendix written after deployment."),
            ("Bound every queue", "Jobs, logs and temporary artifacts need limits by count, age and size. A system that accumulates evidence without a retention rule eventually loses the ability to explain itself under pressure."),
            ("Health is a contract", "A process that started is not necessarily a service that recovered. Success belongs to the health contract: the required state is readable, the critical route responds, and the service can perform the operation that justified the update."),
        ],
        "closing": "Reversibility is a design property. It appears when state, evidence, limits and recovery are visible in the same system.",
    },
    {
        "filename": "study-three.pdf",
        "number": "03",
        "title": "A Small Atlas of Attention",
        "date": "24 July 2026",
        "abstract": "Three coordinates for noticing what a project asks us to see: duration, distance and recurrence.",
        "sections": [
            ("Duration", "Some signals exist only because attention remains after novelty has gone. Duration separates a persistent structure from a momentary surprise. Return to the same material at different speeds and record what remains stable."),
            ("Distance", "Every object changes with viewing distance. Close attention reveals texture and exception; distance reveals repetition and proportion. Neither view is authoritative by itself. The useful description states the distance from which it was made."),
            ("Recurrence", "A detail that appears in unrelated places may be more than coincidence. Recurrence is a prompt to compare contexts, not an excuse to collapse them. Mark each appearance, preserve its local meaning, then ask what relationship can be supported."),
        ],
        "closing": "An atlas does not replace the territory. It makes the return deliberate.",
    },
]


def wrap_lines(text, font, size, width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def paragraph(pdf, text, x, y, width, size=11, leading=17, color=INK):
    pdf.setFillColor(color)
    pdf.setFont("Helvetica", size)
    for line in wrap_lines(text, "Helvetica", size, width):
        pdf.drawString(x, y, line)
        y -= leading
    return y


def chrome(pdf, article, page, pages):
    pdf.setFillColor(PAPER)
    pdf.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    pdf.setStrokeColor(Color(0.08, 0.08, 0.07, alpha=0.35))
    pdf.setLineWidth(0.6)
    pdf.line(MARGIN, PAGE_H - 42, PAGE_W - MARGIN, PAGE_H - 42)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(MARGIN, PAGE_H - 30, "LABORATORY / JOURNAL")
    pdf.drawRightString(PAGE_W - MARGIN, PAGE_H - 30, f"{article['number']} / {page:02d} OF {pages:02d}")
    pdf.drawString(MARGIN, 27, article["date"].upper())
    pdf.drawRightString(PAGE_W - MARGIN, 27, article["title"].upper())


def cover(pdf, article, pages):
    chrome(pdf, article, 1, pages)
    pdf.setFillColor(ACCENT)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(MARGIN, PAGE_H - 112, f"STUDY {article['number']}")
    title_lines = wrap_lines(article["title"], "Helvetica", 43, PAGE_W - MARGIN * 2)
    y = PAGE_H - 180
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica", 43)
    for line in title_lines:
        pdf.drawString(MARGIN, y, line)
        y -= 48
    pdf.setStrokeColor(ACCENT)
    pdf.setLineWidth(2)
    pdf.line(MARGIN, y - 20, MARGIN + 94, y - 20)
    paragraph(pdf, article["abstract"], MARGIN, y - 72, PAGE_W * 0.58, size=13, leading=20, color=MUTED)
    pdf.setFillColor(INK)
    pdf.circle(PAGE_W - MARGIN - 36, 115, 36, fill=0, stroke=1)
    pdf.setFont("Helvetica", 18)
    pdf.drawCentredString(PAGE_W - MARGIN - 36, 108, article["number"])
    pdf.showPage()


def section_page(pdf, article, section, page, pages):
    chrome(pdf, article, page, pages)
    heading, body = section
    pdf.setFillColor(ACCENT)
    pdf.setFont("Helvetica", 9)
    pdf.drawString(MARGIN, PAGE_H - 104, f"{page - 1:02d}")
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica", 28)
    pdf.drawString(MARGIN, PAGE_H - 148, heading)
    pdf.setStrokeColor(ACCENT)
    pdf.setLineWidth(1.2)
    pdf.line(MARGIN, PAGE_H - 170, PAGE_W - MARGIN, PAGE_H - 170)
    y = paragraph(pdf, body, MARGIN, PAGE_H - 220, PAGE_W - MARGIN * 2, size=12, leading=20)
    pdf.setFillColor(Color(0.71, 0.32, 0.14, alpha=0.1))
    pdf.rect(MARGIN, 112, PAGE_W - MARGIN * 2, 176, fill=1, stroke=0)
    pdf.setStrokeColor(ACCENT)
    pdf.setLineWidth(0.8)
    for offset in range(5):
        x = MARGIN + 34 + offset * 89
        pdf.circle(x, 198, 7 + offset * 4, fill=0, stroke=1)
        if offset < 4:
            pdf.line(x + 18, 198, x + 70, 198)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(MARGIN + 24, 132, "OBSERVE")
    pdf.drawCentredString(PAGE_W / 2, 132, "COMPARE")
    pdf.drawRightString(PAGE_W - MARGIN - 24, 132, "RETURN")
    pdf.showPage()


def closing_page(pdf, article, page, pages):
    chrome(pdf, article, page, pages)
    pdf.setFillColor(ACCENT)
    pdf.rect(MARGIN, PAGE_H - 160, 6, 78, fill=1, stroke=0)
    y = paragraph(pdf, article["closing"], MARGIN + 32, PAGE_H - 98, PAGE_W - MARGIN * 2 - 32, size=20, leading=29)
    pdf.setStrokeColor(Color(0.08, 0.08, 0.07, alpha=0.28))
    pdf.setLineWidth(0.6)
    pdf.line(MARGIN, y - 28, PAGE_W - MARGIN, y - 28)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 9)
    pdf.drawString(MARGIN, y - 56, "END OF FIELD NOTE")
    pdf.drawRightString(PAGE_W - MARGIN, y - 56, "LABORATORY / 2026")
    pdf.showPage()


def create_article(article):
    destination = OUTPUT / article["filename"]
    pages = len(article["sections"]) + 2
    pdf = canvas.Canvas(str(destination), pagesize=A4, pageCompression=1)
    pdf.setTitle(article["title"])
    pdf.setAuthor("Laboratory")
    cover(pdf, article, pages)
    for page, section in enumerate(article["sections"], start=2):
        section_page(pdf, article, section, page, pages)
    closing_page(pdf, article, pages, pages)
    pdf.save()
    return destination


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for item in ARTICLES:
        print(create_article(item))
