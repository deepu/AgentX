from build_lib import *
W = {}
# New project
msgs = [me('Start Study MW-310. Same setup as MW-301, but no literature watch for now. Priya is the CRA again, and Tom files documents.'),
  ai(chip('Drafted: <strong>Study MW-310</strong>, from the Phase 3 study template', False),
     p('It starts from the same template as MW-301 and includes the changes MW-301 made since, like waiting 5 days between reminders.'),
     p('I left out the <strong>Safety literature</strong> page. You can add it back any time.'),
     p('Records start empty. Sites and staff come in when you upload the site list or connect your CTMS.'))]
def tcard(t, s, sel=False, dashed=False):
    bd = 'border: 2px solid #6E47D1;' if sel else ('border: 1px dashed #D4D4D8;' if dashed else 'border: 1px solid #E5E5EA;')
    return f'<span style="{bd} border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 2px;"><span style="font-weight: 600;">{t}</span><span style="color: #52525B;">{s}</span></span>'
def colist(head, n, items):
    return f'<section style="display: flex; flex-direction: column; gap: 6px;">{h3(head, n)}' + ''.join(f'<span{" style=\"color: #8A8A92; text-decoration: line-through;\"" if x.startswith("~") else ""}>{x.lstrip("~")}</span>' for x in items) + '</section>'
inner = title('Study MW-310 <span style="font-size: 13px; vertical-align: middle;">' + pill('Draft') + '</span>', 'Starts from a template. Everything below belongs to this project and can be changed here.') + \
  section(h3('Start from'), '<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; font-size: 13px;">' + tcard('Phase 3 study', 'Many sites, visits', True) + tcard('Phase 1 study', 'One site, volunteers') + tcard('Copy a study', 'Start from MW-301') + tcard('Blank', 'Describe it', dashed=True) + '</div>') + \
  '<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; font-size: 13.5px;">' + \
    colist('Pages', 2, ['TMF by site', 'Monitoring visits', '~Safety literature']) + \
    colist('Playbooks', 12, ['File a document', 'Chase missing documents', 'Review a visit report', '<span style="color: #52525B;">9 more</span>']) + \
    colist('Records', '', ['Sites', 'Documents', 'Site staff']) + '</div>' + \
  section(h3('People'), '<span style="font-size: 13.5px;">Anika Rao, study manager · Priya Shah, CRA · Tom Okafor, TMF lead</span>') + \
  '<div style="margin-top: auto; display: flex; gap: 10px; align-items: center; padding-top: 14px; border-top: 1px solid #F0F0F2;"><span style="font-size: 13px; color: #52525B; flex: 1 1 auto;">Nothing runs until you start it.</span>' + btn('Discard', '#') + btn('Start study', 'Main.dc.html', True) + '</div>'
W['NewProject'] = app('New study', 'active="none" project="all"', chat('New study', msgs, 'Describe the study, or change the draft', 'page', (), 'q11'), main('eTMF  ›  New study', inner, '6px 28px 20px'))

# Project settings
msgs = [me('What\'s in the template update?'),
  ai(p('Two changes to playbooks you use, and one new rule:'), ul('<strong>Chase missing documents</strong> waits 5 days between reminders. This project already does that, so nothing changes here.', '<strong>File a document</strong> checks the expiry date on CVs.', 'New rule: lab ranges older than 12 months are flagged.'), p('If you take it, I\'ll do a test run on site 104 first.')),
  me('Also save this project as a template for future studies'),
  ai(chip('Drafted a template: <strong>MW-301 setup</strong> (no records copied)'))]
people = table('1fr 190px', ['Person', 'Role in this project'], [['Anika Rao', 'Study manager · owner'], ['Priya Shah', 'CRA · writes visit reports'], ['Tom Okafor', 'TMF lead · signs for filing'], ['<span style="color: #52525B;">12 site contacts</span>', '<span style="color: #52525B;">Upload by link, no account</span>']])
def tag(t):
    return f'<span style="padding: 5px 10px; border-radius: 8px; border: 1px solid #E5E5EA; font-size: 13px;">{t}</span>'
tmpl = '<div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; font-size: 13.5px;"><span>Started from <strong>Phase 3 study</strong>, version 4 · this project changed 2 playbooks</span><div style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; background: #F5F1FF;"><span style="flex: 1 1 auto;"><strong>Version 5 is out</strong> · 2 playbook changes, 1 new rule</span>' + btn('Review update', '#', True) + '</div></div>'
inner = title('Project settings') + section(h3('Template'), tmpl) + section(h3('People'), people) + \
  section(h3('Connections'), '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' + tag('Study TMF storage') + tag('Study email') + tag('PubMed') + tag('Veeva Vault · read only') + '</div>') + \
  section(h3('Rules'), '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' + tag('Signatures: Part 11 on') + tag('Outgoing email needs approval') + tag('Every AI check shows its quote') + '</div>')
W['Settings'] = app('Project settings', 'active="settings" project="mw301"', chat('Project settings', msgs, 'Ask about this project\'s setup', 'page', (), 'q12'), main('Study MW-301  ›  Project settings', inner))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
