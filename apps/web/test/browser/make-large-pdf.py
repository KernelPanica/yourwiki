"""Create a synthetic range-loading fixture; pass output to YOURWIKI_BROWSER_PDF_FIXTURE."""
import sys
from pathlib import Path
from pypdf import PdfWriter
writer=PdfWriter(clone_from=Path(__file__).resolve().parents[3]/'server/test/fixtures/pdf/form.pdf')
writer.add_attachment('range-regression.bin',bytes(range(256))*16384)
with open(sys.argv[1],'wb') as target:
 writer.write(target)
