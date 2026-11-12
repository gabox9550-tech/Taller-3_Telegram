#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generador universal de documentos (PDF, DOCX, PPTX, XLSX)
usando reportlab, python-docx, python-pptx y openpyxl.
Uso:
    python generador_documentos.py <formato> <ruta_salida> <ruta_json>
"""
import sys
import json
import os


def generar_pdf(salida, datos):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from reportlab.lib import colors

    doc = SimpleDocTemplate(
        salida,
        pagesize=letter,
        rightMargin=54,
        leftMargin=54,
        topMargin=54,
        bottomMargin=54,
    )
    styles = getSampleStyleSheet()

    titulo_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=22,
        leading=26,
        textColor=colors.HexColor('#1E293B'),
        spaceAfter=15,
    )

    subtitulo_style = ParagraphStyle(
        'DocSubTitle',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=18,
        textColor=colors.HexColor('#2563EB'),
        spaceBefore=12,
        spaceAfter=6,
    )

    cuerpo_style = ParagraphStyle(
        'DocBody',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=10,
        leading=14,
        textColor=colors.HexColor('#334155'),
        spaceAfter=8,
    )

    story = []
    titulo = datos.get('titulo', 'Documento Generado')
    story.append(Paragraph(titulo, titulo_style))
    story.append(Spacer(1, 10))

    secciones = datos.get('secciones', [])
    for sec in secciones:
        if isinstance(sec, dict):
            st = sec.get('titulo')
            if st:
                story.append(Paragraph(st, subtitulo_style))
            contenido = sec.get('contenido', '')
            for parrafo in contenido.split('\n\n'):
                if parrafo.strip():
                    story.append(Paragraph(parrafo.strip().replace('\n', '<br/>'), cuerpo_style))
        elif isinstance(sec, str):
            story.append(Paragraph(sec.replace('\n', '<br/>'), cuerpo_style))

    doc.build(story)


def generar_docx(salida, datos):
    import docx
    from docx.shared import Pt, RGBColor

    doc = docx.Document()
    titulo = datos.get('titulo', 'Documento Generado')
    doc.add_heading(titulo, level=0)

    secciones = datos.get('secciones', [])
    for sec in secciones:
        if isinstance(sec, dict):
            st = sec.get('titulo')
            if st:
                doc.add_heading(st, level=1)
            contenido = sec.get('contenido', '')
            for parrafo in contenido.split('\n\n'):
                if parrafo.strip():
                    doc.add_paragraph(parrafo.strip())
        elif isinstance(sec, str):
            doc.add_paragraph(sec.strip())

    doc.save(salida)


def generar_pptx(salida, datos):
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    titulo = datos.get('titulo', 'Presentación Generada')

    # Slide 1: Portada
    slide_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(slide_layout)
    slide.shapes.title.text = titulo
    if slide.placeholders[1]:
        slide.placeholders[1].text = "Generado por Gemini en Telegram Bot"

    # Slides de contenido
    secciones = datos.get('secciones', [])
    for sec in secciones:
        slide_layout = prs.slide_layouts[1]
        slide = prs.slides.add_slide(slide_layout)
        if isinstance(sec, dict):
            slide.shapes.title.text = sec.get('titulo', 'Tema')
            contenido = sec.get('contenido', '')
            body_shape = slide.shapes.placeholders[1]
            tf = body_shape.text_frame
            lineas = [l.strip() for l in contenido.split('\n') if l.strip()]
            if lineas:
                tf.text = lineas[0]
                for linea in lineas[1:]:
                    p = tf.add_paragraph()
                    p.text = linea
        elif isinstance(sec, str):
            slide.shapes.title.text = "Información"
            slide.shapes.placeholders[1].text = sec

    prs.save(salida)


def generar_xlsx(salida, datos):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Datos"

    titulo = datos.get('titulo', 'Reporte')
    ws['A1'] = titulo
    ws['A1'].font = Font(size=14, bold=True, color="1E293B")

    filas = datos.get('filas', [])
    encabezados = datos.get('encabezados', [])

    start_row = 3
    if encabezados:
        for col_idx, h in enumerate(encabezados, start=1):
            cell = ws.cell(row=start_row, column=col_idx, value=h)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill(start_color="2563EB", end_color="2563EB", fill_type="solid")
            cell.alignment = Alignment(horizontal="center")
        start_row += 1

    for row_idx, fila in enumerate(filas, start=start_row):
        for col_idx, val in enumerate(fila, start=1):
            ws.cell(row=row_idx, column=col_idx, value=val)

    # Si vienen secciones de texto en lugar de filas tabulares
    if not filas and 'secciones' in datos:
        ws.cell(row=3, column=1, value="Sección").font = Font(bold=True)
        ws.cell(row=3, column=2, value="Contenido").font = Font(bold=True)
        r = 4
        for sec in datos['secciones']:
            if isinstance(sec, dict):
                ws.cell(row=r, column=1, value=sec.get('titulo', ''))
                ws.cell(row=r, column=2, value=sec.get('contenido', ''))
            r += 1

    wb.save(salida)


def main():
    if len(sys.argv) < 4:
        print("Uso: python generador_documentos.py <formato> <ruta_salida> <ruta_json>")
        return 2

    formato = sys.argv[1].lower()
    salida = sys.argv[2]
    ruta_json = sys.argv[3]

    if not os.path.exists(ruta_json):
        print(f"Error: No existe el archivo JSON {ruta_json}")
        return 2

    with open(ruta_json, 'r', encoding='utf-8') as f:
        datos = json.load(f)

    os.makedirs(os.path.dirname(os.path.abspath(salida)), exist_ok=True)

    if formato == 'pdf':
        generar_pdf(salida, datos)
    elif formato == 'docx':
        generar_docx(salida, datos)
    elif formato == 'pptx':
        generar_pptx(salida, datos)
    elif formato in ('xlsx', 'excel'):
        generar_xlsx(salida, datos)
    else:
        print(f"Formato no soportado: {formato}")
        return 2

    print(f"OK:{salida}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
