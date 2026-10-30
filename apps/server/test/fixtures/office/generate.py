"""Generate small synthetic fixtures; no user documents or embedded fonts."""
from pathlib import Path
from docx import Document
from docx.shared import Pt
from pptx import Presentation
import xlsxwriter
from PIL import Image
from odf.opendocument import OpenDocumentSpreadsheet
from odf.table import Table, TableRow, TableCell
from odf.text import P
root = Path(__file__).parent
word = Document()
word.add_heading('Yourwiki DOCX fixture', 0)
p = word.add_paragraph('Formatted ')
r = p.add_run('bold sample'); r.bold = True; r.font.size = Pt(14)
t = word.add_table(rows=2, cols=2)
t.cell(0,0).merge(t.cell(0,1)).text = 'Merged document title'
t.cell(1,0).text = 'Left'; t.cell(1,1).text = 'Right'
Image.new('RGB',(64,32),'#336699').save(root/'sample.png')
word.add_picture(str(root/'sample.png'))
word.save(root/'document.docx')
book = xlsxwriter.Workbook(str(root/'table.xlsx'))
sheet = book.add_worksheet('Main')
sheet.merge_range('A1:C1','Merged sheet title')
sheet.write_number('A2',3); sheet.write_number('B2',4)
sheet.write_formula('C2','=SUM(A2:B2)',None,7)
book.add_worksheet('Second').write('A1','Second sheet')
book.close()
ods = OpenDocumentSpreadsheet(); table = Table(name='Values'); row = TableRow()
for value in [3,4,7]:
    cell = TableCell(valuetype='float', value=value); cell.addElement(P(text=str(value))); row.addElement(cell)
table.addElement(row); ods.spreadsheet.addElement(table); ods.save(str(root/'table.ods'))
deck = Presentation()
for title in ['First slide','Second slide']:
    slide = deck.slides.add_slide(deck.slide_layouts[0]); slide.shapes.title.text = title
    slide.placeholders[1].text = 'Yourwiki presentation fixture'
deck.save(root/'slides.pptx')
