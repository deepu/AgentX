from build_lib import *
W = {}
def toggle(active):
    a = 'padding: 6px 11px; background: #1C1C1E; color: #FFFFFF;'; b = 'padding: 6px 11px;'
    return f'<span style="flex: 0 0 auto; display: inline-flex; border: 1px solid #D4D4D8; border-radius: 8px; overflow: hidden; font-size: 13px;"><span style="{a if active == "list" else b}">List</span><span style="{a if active == "cards" else b}">Cards</span></span>'
def fchip(t):
    return f'<span style="padding: 5px 11px; border-radius: 999px; background: #F5F1FF; border: 1px solid #DCD0FA; color: #43239E; font-size: 13px;">{t} ✕</span>'

# TMF page
msgs = [me('Where are most of the gaps?'),
  ai(p('Site 104 has the most: 4 of the 23 missing documents. Across sites, most gaps are in site management: CVs, training records and lab ranges.')),
  me('Add a breakdown by TMF zone'),
  ai(chip('Changed the page: added <strong>Missing, by zone</strong>'), p('Added under the chart. Zone 5 (site management) holds 14 of the 23.'))]
zone = table('1fr 80px', ['Zone', 'Missing'], [['05 · Site management', '14'], ['04 · Ethics committee', '4'], ['10 · Data management', '3'], ['Other zones', '2']])
right = '<span style="flex: 0 0 auto; display: flex; gap: 8px;">' + btn('Share', '#') + btn('Pin to Home', 'Main.dc.html') + '</span>'
inner = title('TMF by site', 'Live: reads Sites and Documents · updates as documents are filed', right) + \
  tiles([('Documents in place', '87%', 'all 12 sites'), ('Missing', '23', 'all requested'), ('Expiring', '6', 'in the next 30 days')]) + \
  section(h3('Documents in place, by site'), bars([('Site 101', 94), ('Site 102', 88), ('Site 103', 91), ('Site 104', 61), ('Site 105', 90), ('Site 107', 96), ('Site 109', 78)]) + '<span style="font-size: 12px; color: #6B6B72;">Below 80% in orange · 5 more sites above 90%</span>') + \
  section(changed_head('Missing, by zone'), zone, True)
W['TmfBoard'] = app('A page', 'active="b-tmf" project="mw301"', chat('TMF by site', msgs, 'Ask about this page, or ask to change it', 'page', (), 'q4'), main('Pages  ›  TMF by site', inner))

# Sites list
msgs = [me('Which sites are below 80%, and what are they missing?'),
  ai(p('Two sites. I\'ve filtered the list on the right.'), ul('<strong>Site 104</strong>: protocol signature page, 2 CVs, lab normal ranges', '<strong>Site 109</strong>: ethics approval letter (uploaded today, being checked)'), p('Want this saved as a page?'), btn('Save as a page', 'TmfBoard.dc.html'))]
rows = table('1fr 100px 90px 110px', ['Site', 'Status', 'Documents', 'Missing'], [
  {'href': 'Site.dc.html', 'cells': ['<span style="display: flex; flex-direction: column;"><span style="font-weight: 500;">Site 104</span><span style="font-size: 12.5px; color: #52525B;">[Hospital name], [City]</span></span>', 'Enrolling', '61%', '<span style="color: #8A4B00;">4 documents</span>']},
  {'href': 'Site.dc.html', 'cells': ['<span style="display: flex; flex-direction: column;"><span style="font-weight: 500;">Site 109</span><span style="font-size: 12.5px; color: #52525B;">[Hospital name], [City]</span></span>', 'Starting up', '78%', '<span style="color: #8A4B00;">1 document</span>']}], '14px')
inner = title('Sites <span style="color: #6B6B72; font-weight: 400;">12</span>', 'Every site in this study. Click one for its page.', toggle('list')) + \
  '<div style="display: flex; gap: 8px;">' + fchip('Below 80% · from chat') + '</div>' + rows + \
  '<span style="font-size: 12.5px; color: #6B6B72;">10 more sites hidden by the filter</span>' + \
  note('Records are the project\'s own data: its sites, documents, staff and papers. Each type has a built-in list, and a cards view by status. Playbooks write to them; pages read from them.')
W['Sites'] = app('Records list', 'active="r-sites" project="mw301"', chat('Sites', msgs, 'Ask about these sites', 'list', (), 'q5'), main('Records  ›  Sites', inner))

# Documents as cards by status
def card(t, sub, flag='', tone=''):
    fl = f'<span style="font-size: 12px; color: {"#8A4B00" if tone == "warn" else "#1B6B3A" if tone == "ok" else "#52525B"}; font-weight: 500;">{flag}</span>' if flag else ''
    return f'<a href="Document.dc.html" style="background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 8px; padding: 9px 10px; display: flex; flex-direction: column; gap: 3px; color: #1C1C1E; text-decoration: none; font-size: 13px;"><span style="font-weight: 500; line-height: 1.3;">{t}</span><span style="font-size: 12px; color: #52525B;">{sub}</span>{fl}</a>'
def col(name, n, cards, drop=False):
    bd = 'border: 1.5px dashed #9C86E8; background: #F5F1FF;' if drop else 'background: #F4F4F6;'
    return f'<div style="flex: 1 1 0; min-width: 0; {bd} border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px;"><span style="font-size: 12.5px; font-weight: 600; color: #3F3F46; padding: 2px 2px 4px;">{name} <span style="font-weight: 400; color: #6B6B72;">{n}</span></span>{"".join(cards)}</div>'
cols = '<div style="display: flex; gap: 8px; align-items: flex-start;">' + \
  col('Requested', 23, [card('Lab normal ranges', 'Site 104', '21 days · 2 reminders', 'warn'), card('Protocol signature page', 'Site 104', '9 days'), card('CV, Dr [Name]', 'Site 104', '9 days'), '<span style="font-size: 12px; color: #52525B; padding: 2px;">20 more</span>']) + \
  col('Uploaded', 3, [card('Ethics approval letter', 'Site 109', 'AI checking'), card('Insurance certificate', 'Site 103', 'In the queue')]) + \
  col('AI checked', 5, [card('Delegation log', 'Site 102', '1 issue: unsigned row', 'warn'), card('CV, [Name]', 'Site 106', 'Looks right', 'ok'), '<span style="font-size: 12px; color: #52525B; padding: 2px;">3 more</span>'], True) + \
  col('Filed', '1,809', [card('Protocol signature page', 'Site 101', 'Signed · v2', 'ok'), card('Informed consent v3', 'Site 107', 'Signed', 'ok')]) + '</div>'
msgs = [me('What has been stuck the longest?'),
  ai(p('<strong>Lab normal ranges for site 104.</strong> Requested 21 days ago, with two reminders sent. The coordinator opened the upload link on Monday but hasn\'t uploaded anything yet.'), p('Want me to draft a note to Priya, the CRA, to raise it at the visit?'), btn('Draft a note to Priya', 'Run.dc.html'))]
inner = title('Documents <span style="color: #6B6B72; font-weight: 400;">1,840</span>', 'Cards by status. Drag a card to move it on; dropping on Filed asks for a signature.', toggle('cards')) + \
  '<div style="display: flex; gap: 8px;">' + fchip('Not filed yet') + '</div>' + cols
W['Documents'] = app('Records as cards', 'active="r-docs" project="mw301"', chat('Documents', msgs, 'Ask about these documents', 'page', (), 'q6'), main('Records  ›  Documents', inner))

# Site record page
msgs = [me('Summarise site 104'),
  ai(p('Enrolling since 2 Sep, with 7 participants so far.'), p('Documents are at <strong>61%</strong>. The 4 missing ones were all requested, and two reminders have gone out. The coordinator opened the upload link on Monday.'), p('The monitoring visit is on Wed 28 Oct. This week\'s reminder is waiting for your approval.'), btn('Open the reminder', 'Run.dc.html'))]
missing = table('1fr 110px 90px', ['Missing document', 'Requested', 'Reminders'], [
  {'href': 'Document.dc.html', 'cells': ['Lab normal ranges', '30 Sep', '2']},
  {'href': 'Document.dc.html', 'cells': ['Protocol signature page', '12 Oct', '1']},
  {'href': 'Document.dc.html', 'cells': ['CV, Dr [Name] (sub-investigator)', '12 Oct', '1']},
  {'href': 'Document.dc.html', 'cells': ['CV, [Name] (coordinator)', '12 Oct', '1']}])
runs = table('1fr 150px', None, [
  {'href': 'Run.dc.html', 'cells': ['Chase missing documents · Fri 16 Oct', '<span style="color: #8A4B00;">Waiting for you</span>']},
  {'cells': ['File a document · Mon 12 Oct · delegation log', '<span style="color: #1B6B3A;">Filed</span>']}])
inner = title('Site 104 · [Hospital name]', '[City] · Enrolling · PI Dr [Name] · CRA Priya Shah', btn('Open in EDC', 'XSite.dc.html')) + \
  tiles([('Participants', '7', 'since 2 Sep'), ('Documents', '61%', '4 missing'), ('Next visit', '28 Oct', 'in 7 days')]) + \
  section(h3('Missing documents', 4), missing) + section(h3('Runs for this site'), runs) + \
  section(h3('On these pages'), '<div style="display: flex; gap: 8px; font-size: 13.5px;">' + btn('TMF by site', 'TmfBoard.dc.html') + btn('Site 104 visit readiness', 'Ask.dc.html') + '</div>')
W['Site'] = app('A record page', 'active="r-sites" project="mw301"', chat('Site 104', msgs, 'Ask about this site', 'page', (), 'q7'), main('Records  ›  Sites  ›  Site 104', inner))

# Document record page (regulated)
msgs = [me('Why was version 1 rejected?'),
  ai(p('It was signed against <strong>protocol version 2.0</strong>. The site moved to version 3.0 in September, so the AI flagged it and Tom sent it back on 2 Oct.'), p('Version 2 is signed against 3.0 and was approved for filing on 6 Oct.')),
  me('Export the audit trail for the inspection folder'),
  ai(chip('Exported the audit trail: PDF, 9 entries · <a href="#">Download</a>', False))]
checks = '<div style="display: flex; flex-direction: column; gap: 6px; font-size: 13.5px;"><span><span style="color: #1B6B3A; font-weight: 600;">✓</span> Signed by the PI listed for site 101 · <a href="#">Show quote</a></span><span><span style="color: #1B6B3A; font-weight: 600;">✓</span> Protocol version 3.0 matches · <a href="#">Show quote</a></span><span><span style="color: #1B6B3A; font-weight: 600;">✓</span> Dated after the protocol was approved · <a href="#">Show quote</a></span></div>'
versions = table('60px 1fr 150px', ['Version', 'Uploaded', 'Outcome'], [['v2', '3 Oct, by the site', '<span style="color: #1B6B3A;">Filed</span>'], ['v1', '29 Sep, by the site', '<span style="color: #8A4B00;">Sent back: protocol 2.0</span>']])
sig = '<div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 3px; font-size: 13.5px;"><span><strong>Tom Okafor</strong> · Approved for filing · 6 Oct 2026, 10:42</span><span style="font-size: 12.5px; color: #52525B;">Signed with password · version 2 locked · fingerprint 9f3a…e21c</span></div>'
audit = table('120px 1fr', None, [['6 Oct 10:42', 'Tom Okafor signed v2: approved for filing'], ['5 Oct 16:10', 'AI checked v2: 3 of 3 checks passed'], ['2 Oct 09:15', 'Tom Okafor sent v1 back: protocol 2.0'], ['<span style="color: #52525B;">6 more</span>', '']], '13px')
right = btn('Export audit trail', '#')
inner = title('Protocol signature page', 'Site 101 · TMF zone 05 · ' + pill('Filed', 'green') + ' · version 2', right) + \
  section(h3('What the AI checked'), checks) + section(h3('Signature'), sig) + \
  section(h3('Versions'), versions) + section(h3('Audit trail'), audit)
W['Document'] = app('A regulated record', 'active="r-docs" project="mw301"', chat('Protocol signature page', msgs, 'Ask about this document', 'page', (), 'q8'), main('Records  ›  Documents  ›  Protocol signature page, site 101', inner, '6px 28px 20px'))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
