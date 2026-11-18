import os
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch

pdf_path = r"C:\Users\lcsso\reims-mac\GUIA_REIMS_DEBIAN.pdf"
downloads_pdf = r"C:\Users\lcsso\Downloads\GUIA_REIMS_DEBIAN.pdf"

doc = SimpleDocTemplate(
    pdf_path,
    pagesize=letter,
    rightMargin=36,
    leftMargin=36,
    topMargin=36,
    bottomMargin=36
)

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle(
    'DocTitle',
    parent=styles['Normal'],
    fontName='Helvetica-Bold',
    fontSize=22,
    leading=26,
    textColor=colors.HexColor('#16213e')
)

subtitle_style = ParagraphStyle(
    'DocSubTitle',
    parent=styles['Normal'],
    fontName='Helvetica-Bold',
    fontSize=12,
    leading=16,
    textColor=colors.HexColor('#e94560')
)

h1_style = ParagraphStyle(
    'H1',
    parent=styles['Heading1'],
    fontName='Helvetica-Bold',
    fontSize=14,
    leading=18,
    textColor=colors.HexColor('#0f3460'),
    spaceAfter=6,
    keepWithNext=True
)

body_style = ParagraphStyle(
    'Body',
    parent=styles['Normal'],
    fontName='Helvetica',
    fontSize=10,
    leading=14,
    textColor=colors.HexColor('#222222'),
    spaceAfter=6
)

code_style = ParagraphStyle(
    'CodeBlock',
    parent=styles['Normal'],
    fontName='Courier-Bold',
    fontSize=9.5,
    leading=13,
    textColor=colors.HexColor('#111111')
)

cmd_desc_style = ParagraphStyle(
    'CmdDesc',
    parent=styles['Normal'],
    fontName='Helvetica',
    fontSize=9,
    leading=12,
    textColor=colors.HexColor('#333333')
)

story = []

# Header
story.append(Paragraph("GUIA DEFINITIVO: macOS Tahoe com REIMS", title_style))
story.append(Paragraph("Passo a Passo 'Plug & Play' no Debian · Ryzen 5 5600X · RTX 3070 · Cockpit Web UI", subtitle_style))
story.append(Spacer(1, 10))
story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor('#e94560'), spaceAfter=14))

# Intro Box
info_data = [
    [Paragraph("<b>Hardware Alvo Calibrado:</b> AMD Ryzen 5 5600X (4C/8T dedicados) | NVIDIA GeForce RTX 3070 (Reims vGPU Vulkan) | 10 GB RAM | SSD NVMe<br/><b>Sistema Host:</b> Debian Minimal (sem interface gráfica pesada, Debian atua como backend invisível).", body_style)]
]
info_table = Table(info_data, colWidths=[540])
info_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#f0f4f8')),
    ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#0f3460')),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('RIGHTPADDING', (0,0), (-1,-1), 10),
]))
story.append(info_table)
story.append(Spacer(1, 14))

# Seção 1: O que fazer no Windows antes de reiniciar
story.append(Paragraph("1. No Windows: Copiar a Pasta para a Pen Drive", h1_style))
story.append(Paragraph("Basta copiar a pasta completa <b>reims-mac</b> localizada em <code>C:\\Users\\lcsso\\reims-mac</code> direto para a raiz da sua pen drive. Todos os arquivos de inicialização, OpenCore, scripts e o Cockpit já estão nela.", body_style))
story.append(Spacer(1, 10))

# Seção 2: Passo a Passo no Debian (O que digitar)
story.append(Paragraph("2. No Debian: Os Comandos Exatos que Você Vai Digitar", h1_style))
story.append(Paragraph("Assim que você ligar o computador e entrar no terminal do Debian com seu login e senha, digite os comandos na sequência abaixo:", body_style))

steps_data = [
    [
        Paragraph("<b>Passo</b>", ParagraphStyle('H', parent=code_style, fontName='Helvetica-Bold', textColor=colors.white)),
        Paragraph("<b>Comando no Terminal</b>", ParagraphStyle('H', parent=code_style, fontName='Helvetica-Bold', textColor=colors.white)),
        Paragraph("<b>O que este comando faz</b>", ParagraphStyle('H', parent=code_style, fontName='Helvetica-Bold', textColor=colors.white))
    ],
    [
        Paragraph("<b>1</b>", body_style),
        Paragraph("<code>cd /media/$USER/*/reims-mac<br/># ou: cd /mnt/usb/reims-mac</code>", code_style),
        Paragraph("Entra na pasta do projeto na sua pen drive.", cmd_desc_style)
    ],
    [
        Paragraph("<b>2</b>", body_style),
        Paragraph("<code>chmod +x reims scripts/*.sh tools/*.sh</code>", code_style),
        Paragraph("Concede permissão de execução para todos os scripts do projeto.", cmd_desc_style)
    ],
    [
        Paragraph("<b>3</b>", body_style),
        Paragraph("<code>./reims setup</code>", code_style),
        Paragraph("<b>O comando mestre de configuração:</b> instala dependências, drivers NVIDIA, Vulkan, KVM, udmabuf e copia os arquivos UEFI OVMF automaticamente sem quebrar o Debian.", cmd_desc_style)
    ],
    [
        Paragraph("<b>4</b>", body_style),
        Paragraph("<code>./reims create</code>", code_style),
        Paragraph("Cria o disco virtual de 80GB no NVMe e baixa a imagem oficial de recuperação do <b>macOS Tahoe</b> da Apple.", cmd_desc_style)
    ],
    [
        Paragraph("<b>5</b>", body_style),
        Paragraph("<code>./reims start</code>", code_style),
        Paragraph("<b>Inicia o macOS Tahoe:</b> roda o pré-voo automático, valida a RTX 3070 com Vulkan e abre o macOS em tela cheia.", cmd_desc_style)
    ],
    [
        Paragraph("<b>6</b>", body_style),
        Paragraph("<code>./reims cockpit</code>", code_style),
        Paragraph("Ativa o <b>Painel Web Cockpit na porta 9090</b> para você controlar a VM de qualquer celular ou PC pelo navegador.", cmd_desc_style)
    ]
]

steps_table = Table(steps_data, colWidths=[40, 240, 260])
steps_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#0f3460')),
    ('ALIGN', (0,0), (-1,-1), 'LEFT'),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cccccc')),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#ffffff'), colors.HexColor('#f9fbfd')]),
    ('TOPPADDING', (0,0), (-1,-1), 6),
    ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
    ('RIGHTPADDING', (0,0), (-1,-1), 6),
]))
story.append(steps_table)
story.append(Spacer(1, 14))

# Seção 3: Painel Cockpit
story.append(Paragraph("3. Como Usar o Cockpit no Celular / Outro Computador", h1_style))
story.append(Paragraph("Como o seu Debian é uma instalação mínima sem navegador gráfico, o Cockpit foi desenhado exatamente para isso: você gerencia tudo pelo celular ou pelo Windows através do navegador da rede local.", body_style))

cockpit_box_data = [
    [
        Paragraph("""
<b>1.</b> No terminal do Debian, digite: <code>hostname -I</code> para ver o IP do seu computador (exemplo: <code>192.168.1.15</code>).<br/>
<b>2.</b> Abra o navegador no seu celular, tablet ou outro computador conectado no mesmo Wi-Fi.<br/>
<b>3.</b> Acesse: <b><code>https://IP-DO-DEBIAN:9090</code></b> (aceite o aviso de certificado autoassinado na primeira vez).<br/>
<b>4.</b> Faça login com o seu usuário e senha normais do Debian.<br/>
<b>5.</b> No menu lateral, clique em <b>macOS Tahoe (REIMS)</b> para ver os botões de Iniciar, Parar, Reset, monitor de temperatura da RTX 3070 e trocar drivers com 1 clique!
""", body_style)
    ]
]
cockpit_table = Table(cockpit_box_data, colWidths=[540])
cockpit_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#fff9e6')),
    ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#ffd460')),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('RIGHTPADDING', (0,0), (-1,-1), 10),
]))
story.append(cockpit_table)
story.append(Spacer(1, 14))

# Seção 4: Se algo quebrar
story.append(Paragraph("4. O Que Fazer se o macOS Quebrar Após uma Atualização", h1_style))
story.append(Paragraph("Diferente de antes, você <b>nunca mais precisará reinstalar o sistema do zero</b>. O REIMS utiliza um disco de camada imutável (*Backing File*).", body_style))

reset_data = [
    [
        Paragraph("""
Se uma atualização do macOS alterar drivers ou o sistema travar na maçã:<br/>
Execute apenas: <b><code>./reims reset</code></b><br/>
<i>O comando descarta a camada temporária corrompida e cria uma nova em 2 segundos a partir da imagem base. O macOS volta limpo e funcionando instantaneamente.</i>
""", body_style)
    ]
]
reset_table = Table(reset_data, colWidths=[540])
reset_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#fbebee')),
    ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#e94560')),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('LEFTPADDING', (0,0), (-1,-1), 10),
    ('RIGHTPADDING', (0,0), (-1,-1), 10),
]))
story.append(reset_table)
story.append(Spacer(1, 14))

# Seção 5: Guia Rápido de Comandos
story.append(Paragraph("5. Resumo de Todos os Comandos (Cheat Sheet)", h1_style))
cmds_summary = [
    [Paragraph("<b>Comando</b>", ParagraphStyle('H', parent=code_style, fontName='Helvetica-Bold', textColor=colors.white)),
     Paragraph("<b>Finalidade</b>", ParagraphStyle('H', parent=code_style, fontName='Helvetica-Bold', textColor=colors.white))],
    [Paragraph("<code>./reims</code>", code_style), Paragraph("Abre o menu interativo com caixas de diálogo coloridas.", cmd_desc_style)],
    [Paragraph("<code>./reims start</code>", code_style), Paragraph("Inicia o macOS Tahoe com aceleração gráfica vGPU.", cmd_desc_style)],
    [Paragraph("<code>./reims doctor</code>", code_style), Paragraph("Testa KVM, udmabuf e Vulkan na RTX 3070.", cmd_desc_style)],
    [Paragraph("<code>./reims monitor</code>", code_style), Paragraph("Mostra temperatura da GPU, VRAM e CPU ao vivo.", cmd_desc_style)],
    [Paragraph("<code>./reims backup</code>", code_style), Paragraph("Cria um backup comprimido com verificação de integridade.", cmd_desc_style)],
    [Paragraph("<code>./reims restore</code>", code_style), Paragraph("Restaura um backup anterior selecionado da lista.", cmd_desc_style)],
    [Paragraph("<code>./reims logs tail</code>", code_style), Paragraph("Exibe a saída do QEMU em tempo real.", cmd_desc_style)],
    [Paragraph("<code>./reims qol tudo</code>", code_style), Paragraph("Ativa clipboard compartilhado e atalho no Desktop.", cmd_desc_style)],
    [Paragraph("<code>./reims agy</code>", code_style), Paragraph("Instala o Antigravity CLI para conversar com a IA no Debian.", cmd_desc_style)]
]
summary_table = Table(cmds_summary, colWidths=[180, 360])
summary_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#16213e')),
    ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#dddddd')),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
    ('RIGHTPADDING', (0,0), (-1,-1), 6),
]))
story.append(summary_table)

doc.build(story)
print(f"PDF criado com sucesso em: {pdf_path}")

# Copia para downloads para conveniência
import shutil
shutil.copy2(pdf_path, downloads_pdf)
print(f"Copia criada em: {downloads_pdf}")
