from build_lib import *
W = {}
SB = 'project="lit"'
AV = '<span style="display: inline-flex;">' + ''.join(f'<span style="width: 26px; height: 26px; border-radius: 50%; background: {bg}; border: 2px solid #FFFFFF; margin-left: {ml}; font-size: 10.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;">{t}</span>' for t, bg, ml in [('LP', '#E6E6EA', '0'), ('OH', '#DCE8F5', '-8px'), ('+4', '#F4F4F6', '-8px')]) + '</span>'

def doi(d):
    return f'<a href="https://doi.org/{d}">doi:{d}</a>'
def quote(t, src):
    return f'<div style="border-left: 3px solid #9C86E8; background: #FBF9FF; padding: 8px 12px; font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; gap: 4px;"><span>“{t}”</span><span style="font-size: 12px; color: #52525B;">{src}</span></div>'
def mark(t):
    return f'<span style="background: #EFEAFD; color: #43239E; padding: 0 3px; border-radius: 3px;">{t}</span>'
def num(t):
    return f'<span style="text-decoration: underline dotted #9C86E8; text-underline-offset: 3px;">{t}</span>'
def mute(t):
    return f'<span style="color: #6B6B72;">{t}</span>'
def diffbars(rows, mx=15):
    out = '<div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">'
    for lab, sub, v, col in rows:
        out += f'<div style="display: grid; grid-template-columns: 190px 1fr 56px; align-items: center; gap: 10px;"><span style="display: flex; flex-direction: column;"><span>{lab}</span><span style="font-size: 11.5px; color: #6B6B72;">{sub}</span></span><span style="height: 12px; border-radius: 3px; background: #EDEDF1;"><span style="display: block; width: {v / mx * 100:.1f}%; height: 12px; border-radius: 3px; background: {col};"></span></span><span style="text-align: right; font-variant-numeric: tabular-nums; font-weight: 500;">{v:.1f}</span></div>'
    return out + '</div>'
def changed_tag(t='Changed from chat'):
    return f'<span style="font-size: 12px; color: #6E47D1;">{t} · <a href="#">Undo</a></span>'

# ---------- Home ----------
left = f'''    <section aria-label="Chat" style="width: 488px; flex: 0 0 488px; box-sizing: border-box; background: #FFFFFF; border: 1px solid #E5E5EA; border-radius: 12px; display: flex; flex-direction: column; padding: 0 32px;">
      <div style="flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 22px;">
        <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 30px; text-align: center;">What do you want to know from the literature?</h1>
        <form style="display: flex; flex-direction: column;">
          <label for="lask" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);">Your question</label>
          <div style="border: 1.5px solid #9C86E8; border-radius: 16px; padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 18px;">
            <textarea id="lask" rows="2" placeholder="Ask a question about the evidence" style="border: 0; outline: none; resize: none; font: inherit; font-size: 16px; color: #1C1C1E; background: transparent;"></textarea>
            <div style="display: flex; align-items: center; gap: 8px; color: #52525B; font-size: 14px;">
              <span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">PubMed</span><span style="padding: 3px 9px; border-radius: 999px; background: #F4F4F6;">Our papers</span>
              <span style="flex: 1 1 auto;"></span><span>Sonnet 5.5 ⌄</span>
              <a href="LAsk.dc.html" aria-label="Ask" style="width: 32px; height: 32px; border-radius: 50%; background: #1C1C1E; color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; text-decoration: none;">{SEND}</a>
            </div>
          </div>
        </form>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: #52525B;">Try asking</span>
          <a href="LAsk.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">How often do people stop oral GLP-1s because of side effects?</a>
          <a href="LAsk.dc.html" style="padding: 10px 12px; border: 1px solid #E5E5EA; border-radius: 10px; color: #1C1C1E; text-decoration: none; font-size: 14px;">Does weight come back after switching from injections to a pill?</a>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <span style="font-size: 13px; font-weight: 600; color: #52525B;">Recent chats, each with its page</span>
          <a href="LBoard.dc.html" style="display: flex; justify-content: space-between; padding: 8px 2px; color: #1C1C1E; text-decoration: none; font-size: 14px; border-bottom: 1px solid #F0F0F2;"><span>Weight loss</span><span style="color: #6B6B72;">Page · Mon</span></a>
          <a href="LRun.dc.html" style="display: flex; justify-content: space-between; padding: 8px 2px; color: #1C1C1E; text-decoration: none; font-size: 14px;"><span>Reply to Dr Adeyemi</span><span style="color: #6B6B72;">Enquiry · Tue</span></a>
        </div>
      </div>
    </section>'''
changed = '<a href="LChange.dc.html" style="border: 1px solid #DCD0FA; background: #FBF9FF; border-radius: 12px; padding: 13px 16px; display: flex; flex-direction: column; gap: 6px; color: #1C1C1E; text-decoration: none;"><span style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 14.5px; font-weight: 600; flex: 1 1 auto;">GLP-1 › Weight loss: one new finding</span>' + '<span style="font-size: 12px;">' + pill('Needs your review', 'orange') + '</span>' + '</span><span style="font-size: 13.5px; line-height: 1.5;">ATTAIN-MAINTAIN: after switching from weekly injections, people on orforglipron kept 75 to 79% of the weight they had lost, against 38 to 49% on placebo.</span><span style="font-size: 12.5px; color: #6B6B72;">Found by Monday\'s refresh · nothing else on the page moved</span></a>'
pages = table('1fr 1.3fr 90px', ['Page', 'What it says now', 'Refreshed'], [
  {'href': 'LBoard.dc.html', 'cells': [mute('GLP-1 ›') + ' Weight loss', '9 to 13 points more than placebo', 'Mon']},
  {'href': 'LTopic.dc.html', 'cells': [mute('GLP-1 ›') + ' Type 2 diabetes', 'ATTAIN-2: 7.1 points more than placebo at 36 mg', 'Mon']},
  {'cells': ['Heart failure', 'SGLT2 inhibitors · 3 sub-pages, nothing new', 'Mon']},
  {'cells': ['Pipeline watch', 'Emailed to 6 people each month', '1 May']}], '13.5px')
inner = title('Literature search', 'Medical affairs · PubMed and our own papers · from the Literature template', AV) + \
  section(h3('What changed this week'), changed) + \
  section(h3('Waiting for you', 2), '<div style="display: flex; flex-direction: column; gap: 8px;">' +
    waitrow('Review an answer change', 'Weight loss · 1 new trial', 'From the page\'s Monday refresh', 'LChange.dc.html', True) +
    waitrow('Sign a reply to a doctor', 'Dr Ruth Adeyemi: is oral semaglutide 25 mg as good as the injection?', 'From <span style="color: #5B34C9;">Answer an enquiry</span>, step 4 · due Fri', 'LRun.dc.html') + '</div>') + \
  section(h3('Pages kept up to date', 4), pages)
W['LHome'] = app('Literature search home', 'active="home" ' + SB, left, main('Home  ·  Wed 3 June', inner, '4px 28px 20px'))

# ---------- Ask: a page built for the question ----------
msgs = [me('How often do people stop oral GLP-1s because of side effects?'),
  ai(tools('Searched PubMed: 13 randomised trials of oral GLP-1s for weight since 2023', 'Read the abstracts of the 5 phase 3 trials'),
     p('<strong>In the orforglipron trials, 5 to 10% stopped because of side effects, against 3 to 4% on placebo.</strong> In OASIS 2, 4.5% stopped on oral semaglutide 50 mg.'),
     p('The other oral semaglutide abstracts don\'t give this number. They report stomach and gut side effects instead: 80% against 46% on placebo in OASIS 1.'),
     p('I put it on a page on the right, as a draft under <strong>GLP-1</strong>. To fill the gaps I can read the full papers.'))]
right_btn = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">' + btn('Keep this page', 'LBoard.dc.html', True) + '<span style="font-size: 12px; color: #52525B;">Under GLP-1 ⌄ · refresh weekly ⌄</span></span>'
rows = [
  ['ATTAIN-1', 'Orforglipron 6–36 mg', num('5.3–10.3%') + ' vs 2.7%', mute('Not in abstract'), '<a href="#">NEJM 2025</a>'],
  ['ATTAIN-2', 'Orforglipron 6–36 mg, with T2D', num('6.1–9.9%') + ' vs 4.1%', mute('Not in abstract'), '<a href="LPaper.dc.html">Lancet 2025</a>'],
  ['OASIS 2', 'Oral semaglutide 50 mg', num('4.5%') + mute(' · placebo not given'), num('63.4%') + ' vs 34.8%', '<a href="#">JAMA IM 2025</a>'],
  ['OASIS 1', 'Oral semaglutide 50 mg', mute('Not in abstract'), num('80%') + ' vs 46%', '<a href="#">Lancet 2023</a>'],
  ['OASIS 4', 'Oral semaglutide 25 mg', mute('Not in abstract'), num('74.0%') + ' vs 42.2%', '<a href="#">NEJM 2025</a>']]
tbl = table('80px 1.2fr 1.1fr 1fr 96px', ['Trial', 'Drug', 'Stopped for side effects', 'Stomach or gut side effects', 'Source'], rows, '13px')
gap = '<div style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: #F9F9FA; font-size: 13px;"><span style="flex: 1 1 auto; color: #3F3F46;">3 trials don\'t say in the abstract how many stopped. The full papers will.</span>' + btn('Read the full papers', '#') + '</div>'
inner = title('Side effects', pill('Draft page') + '  Built for your question · 5 trial abstracts from PubMed', right_btn) + \
  p('<span style="font-size: 15px; line-height: 1.5;">With orforglipron, <strong>5 to 10% stopped</strong> because of side effects, against <strong>3 to 4%</strong> on placebo. Most side effects were in the stomach and gut, and mild to moderate.</span>') + \
  tiles([('Stopped, orforglipron', '5–10%', 'vs 3–4% on placebo'), ('Stopped, oral semaglutide', '4.5%', 'OASIS 2 only'), ('Gut side effects', '63–80%', 'vs 35–46% on placebo')]) + \
  section(h3('By trial'), tbl + quote('Adverse events resulted in treatment discontinuation in 5.3 to 10.3% of the patients in the orforglipron groups and in 2.7% of those in the placebo group.', 'ATTAIN-1 · Wharton S et al. N Engl J Med 2025 · ' + doi('10.1056/NEJMoa2511774'))) + gap
W['LAsk'] = app('Ask and get a page', 'active="lb-side" draft="true" ' + SB,
  chat('Side effects', msgs, 'Ask about this page, or ask to change it', 'page', ('PubMed',), 'lq1'),
  main('Pages  ›  GLP-1  ›  Side effects', inner, '6px 28px 20px'))

# ---------- Review an answer change ----------
msgs = [me('What changed?'),
  ai(p('Monday\'s refresh found <strong>one new trial</strong> that fits this page: ATTAIN-MAINTAIN, in Nature Medicine. It\'s about keeping weight off after switching from injections, so I\'d add it as a new section. The chart and the headline don\'t move.'),
     p('It also found two papers I\'d leave out: an indirect comparison of oral and injected semaglutide (not a trial), and a 16-week trial in depression where weight was a side outcome.')),
  me('Mention the indirect comparison under the chart, clearly marked as indirect'),
  ai(chip('Changed the update: added a note under the chart'), p('Added. It says the comparison is indirect, so it isn\'t counted in the chart.'))]
before_after = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13.5px; line-height: 1.5;"><div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 4px;"><span style="font-size: 12px; font-weight: 600; color: #52525B;">THE PAGE SAYS NOW</span><span>Oral GLP-1s give 9 to 13 points more weight loss than placebo, and 7 points in people with type 2 diabetes.</span></div><div style="border: 1px solid #DCD0FA; background: #FBF9FF; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 4px;"><span style="font-size: 12px; font-weight: 600; color: #43239E;">AFTER THIS CHANGE</span><span>The same, plus: ' + mark('after switching from weekly injections, orforglipron kept about three quarters of the weight lost, against 38 to 49% on placebo.') + '</span></div></div>'
maint = table('1fr 150px 130px', ['Switched from', 'Kept on orforglipron', 'Kept on placebo'], [['Tirzepatide (205 people)', num('74.7%'), '49.2%'], ['Semaglutide (171 people)', num('79.3%'), '37.6%']], '13px')
newsec = '<section style="border-left: 3px solid #9C86E8; padding-left: 14px; display: flex; flex-direction: column; gap: 8px;"><div style="display: flex; align-items: baseline; gap: 10px;">' + h3('New section: keeping weight off after injections') + '<span style="font-size: 12px; color: #6E47D1;">From the refresh</span></div>' + maint + quote('Cohort 1 participants who achieved body weight plateau maintained a model-based estimate (MBE) of 74.7% (s.e.m. 4.05) of body weight reduction with orforglipron compared with an MBE of 49.2% (s.e.m. 3.92) with placebo', 'ATTAIN-MAINTAIN · Aronne LJ et al. Nat Med 2026 · ' + doi('10.1038/s41591-026-04386-7')) + '</section>'
notesec = '<section style="border-left: 3px solid #9C86E8; padding-left: 14px; display: flex; flex-direction: column; gap: 6px;"><div style="display: flex; align-items: baseline; gap: 10px;">' + h3('Note under the chart') + changed_tag() + '</div><span style="font-size: 13.5px; line-height: 1.5;">An <strong>indirect</strong> comparison found oral semaglutide 25 mg and the weekly 2.4 mg injection gave similar weight loss (difference 1.0 points, 95% CI −1.6 to 3.6). It compares two separate trials, so it isn\'t in the chart. <a href="#">Plotkin M et al. 2026</a></span></section>'
leftout = '<span style="font-size: 12.5px; color: #6B6B72;">Left out: <a href="#">Semaglutide for cognitive dysfunction in depression</a>, 16 weeks, weight a secondary outcome. <a href="#">Why</a></span>'
footer = '<div style="margin-top: auto; display: flex; gap: 10px; align-items: center; padding-top: 14px; border-top: 1px solid #F0F0F2;"><span style="font-size: 13px; color: #52525B; flex: 1 1 auto;">Accepting updates the page for everyone in the project.</span>' + btn('Send back', '#') + btn('Accept change', 'LBoard.dc.html', True) + '</div>'
inner = title('Review an answer change', '<a href="LBoard.dc.html">Weight loss</a> · found by Monday\'s refresh, 1 June') + before_after + newsec + notesec + leftout + footer
W['LChange'] = app('Review an answer change', 'active="waiting" ' + SB, chat('Weight loss: change', msgs, 'Ask about this change', 'change', (), 'lq2'), main('Waiting for you  ›  Review an answer change', inner, '6px 28px 20px'))

# ---------- The page, kept up to date ----------
msgs = [me('Add how long each trial ran and how many people were in it'),
  ai(chip('Added 2 columns to the trials table: People, Weeks'), p('Both come from the abstracts, and each cell links to its sentence. The columns are now on the Papers list too, so other pages can use them.')),
  me('Who sees this page?'),
  ai(p('Everyone in Literature search. Its headline also goes into the <a href="LPlaybook.dc.html">monthly digest</a>, which emails 6 people.'))]
refresh = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 5px 10px; border-radius: 8px; background: #F5F1FF; color: #43239E; font-weight: 500;">↻ Refreshes every Monday</span><span style="font-size: 12px; color: #52525B;">Last: Mon 1 June · accepted by Leah</span></span>'
chart = diffbars([('OASIS 2', '50 mg · East Asia, 25% with T2D', 13.1, '#5B34C9'), ('OASIS 1', 'Oral semaglutide 50 mg', 12.7, '#5B34C9'), ('OASIS 4', 'Oral semaglutide 25 mg', 11.4, '#5B34C9'), ('ATTAIN-1', 'Orforglipron 36 mg', 9.1, '#5B34C9'), ('ATTAIN-2', 'Orforglipron 36 mg · with T2D', 7.1, '#C26A00')])
hl = 'background: #FBF9FF; color: #43239E;'
trials = table('72px 1.3fr 56px 52px 64px 62px', ['Trial', 'Drug', '<span style="' + hl + '">People</span>', '<span style="' + hl + '">Weeks</span>', 'On drug', 'Placebo'], [
  ['OASIS 1', 'Semaglutide 50 mg', num('667'), num('68'), '−15.1%', '−2.4%'],
  ['OASIS 2', 'Semaglutide 50 mg', num('201'), num('68'), '−14.3%', '−1.3%'],
  ['OASIS 4', 'Semaglutide 25 mg', num('307'), num('64'), '−13.6%', '−2.2%'],
  ['ATTAIN-1', 'Orforglipron 36 mg', num('3,127'), num('72'), '−11.2%', '−2.1%'],
  {'href': 'LPaper.dc.html', 'cells': ['ATTAIN-2', 'Orforglipron 36 mg, T2D', num('1,613'), num('72'), '−9.6%', '−2.5%']}], '13px')
hist = '<span style="font-size: 13px; color: #3F3F46;"><strong>History:</strong> 1 June, ATTAIN-MAINTAIN added, accepted by Leah · 25 May, nothing new · 4 May, made from Omar\'s question · <a href="LChange.dc.html">All changes</a></span>'
inner = title('Weight loss', 'Oral GLP-1s vs placebo · 5 phase 3 trials', refresh) + \
  p('<span style="font-size: 15px; line-height: 1.5;">Oral GLP-1s gave <strong>9 to 13 points more</strong> weight loss than placebo over 64 to 72 weeks. In people with type 2 diabetes, <strong>7 points</strong>. After switching from injections, most of the weight lost stayed off.</span>') + \
  section(h3('Extra weight lost vs placebo, percentage points'), chart + '<span style="font-size: 12px; color: #6B6B72;">ATTAIN-1 is worked out from its two arms. Indirect comparisons are noted, not charted.</span>') + \
  section('<div style="display: flex; align-items: baseline; gap: 10px;">' + h3('Trials') + changed_tag() + '</div>', trials) + \
  section(h3('Keeping weight off after injections', 'added 1 June'), '<span style="font-size: 13.5px; line-height: 1.5;">ATTAIN-MAINTAIN: people who switched from weekly injections to orforglipron kept ' + num('75 to 79%') + ' of the weight lost, against 38 to 49% on placebo, at 52 weeks.</span>') + hist
W['LBoard'] = app('A page kept up to date', 'active="lb-weight" ' + SB, chat('Weight loss', msgs, 'Ask about this page, or ask to change it', 'page', ('PubMed',), 'lq3'), main('Pages  ›  GLP-1  ›  Weight loss', inner, '6px 28px 20px'))

# ---------- Playbook: answer a medical enquiry ----------
msgs = [me('If a question is about a use that isn\'t on the label, the reply should say so in its first line'),
  ai(chip('Drafted a change: <strong>step 3</strong>'), p('Drafted. The live playbook keeps working as it is until the change is approved.'), p('Want a test run on last week\'s enquiries? It only drafts replies; nothing is sent.')),
  me('Yes'),
  ai(tools('Test run on 3 enquiries from last week'), p('One of the three was about an unlicensed use, and its draft now says that in the first line. The other two didn\'t change.'))]
banner = '<div style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: #F5F1FF; border: 1px solid #DCD0FA; font-size: 13.5px;"><span style="flex: 1 1 auto;"><strong>Draft from chat:</strong> 1 change · test run passed</span>' + btn('Discard', '#') + btn('Send for review', '#', True) + '</div>'
steps = table('28px 1fr 120px', ['', 'Step', 'Who'], [
  ['1', 'Read the enquiry and who sent it', 'Agent'],
  ['2', 'Find the evidence: this project\'s pages first, then PubMed', 'Agent'],
  {'cells': ['3', 'Draft the reply with references <span style="color: #43239E; background: #EFEAFD; padding: 0 4px; border-radius: 3px;">and say first if the use is off-label</span>', 'Agent'], 'style': ' background: #FBF9FF;'},
  ['4', 'Medical review and signature', 'Medical lead'],
  ['5', 'Send the reply and file it with the enquiry', 'System']], '13.5px')
runs = table('1fr 130px 130px', ['Enquiries this week', 'Where', 'Status'], [
  {'href': 'LRun.dc.html', 'cells': ['Dr Ruth Adeyemi · oral semaglutide 25 mg vs the injection', 'Step 4 · sign', '<span style="color: #8A4B00;">Waiting for Leah</span>']},
  {'cells': ['Pharmacist, Leeds · taking orforglipron with food', 'Step 2 · evidence', '<span style="color: #6E47D1;">Running</span>']},
  {'cells': ['Dr Mei Lin · ATTAIN-2 results', 'Done', '<span style="color: #1B6B3A;">Sent Tue</span>']}], '13.5px')
inner = title('Answer an enquiry', pill('Live · version 1', 'green') + '  Drafts replies to doctors\' questions. A medical lead signs every reply.') + banner + \
  section(h3('Starts when'), '<span style="font-size: 14px;">An email arrives at the medical information inbox, or someone forwards one</span>') + \
  section(h3('Steps'), steps) + section('', runs) + \
  '<span style="font-size: 12.5px; color: #6B6B72;">Project rules it follows: every number links to its sentence · outgoing email needs approval.</span>'
W['LPlaybook'] = app('A playbook', 'active="lp-enq" ' + SB, chat('Answer an enquiry', msgs, 'Ask about this playbook, or ask to change it', 'playbook', (), 'lq4'), main('Playbooks  ›  Answer an enquiry', inner, '6px 28px 20px'))

# ---------- Run: one enquiry ----------
msgs = [me('Is "similar" fair? It\'s only an indirect comparison.'),
  ai(p('It\'s fair if the letter says how it was done. The paper compares two separate trials, OASIS 4 and STEP 1, and its confidence interval (−1.6 to 3.6) includes zero.'),
     p('The draft didn\'t say it was indirect, so I\'ve added a sentence.'),
     chip('Changed the reply: added that the comparison is indirect'))]
letter = '''<div style="border: 1px solid #E5E5EA; border-radius: 10px; font-size: 13.5px; line-height: 1.55;">
  <div style="padding: 9px 14px; border-bottom: 1px solid #F0F0F2; color: #52525B;">To: Dr Ruth Adeyemi · Re: oral semaglutide 25 mg vs the weekly injection</div>
  <div style="padding: 10px 14px; display: flex; flex-direction: column; gap: 7px;">
    <span>Dear Dr Adeyemi,</span>
    <span>No trial has compared oral semaglutide 25 mg with the 2.4 mg weekly injection directly. In OASIS 4, people taking 25 mg lost 13.6% of their body weight over 64 weeks, against 2.2% on placebo [1].</span>
    <span>A comparison with the STEP 1 trial of the injection found similar weight loss (difference 1.0 percentage points, 95% CI −1.6 to 3.6) [2]. <span style="background: #EFEAFD; color: #43239E; padding: 0 3px; border-radius: 3px;">This comparison is indirect, across two separate trials, and should be read with caution.</span></span>
    <span style="font-size: 12.5px; color: #52525B;">[1] Wharton S et al. N Engl J Med 2025. ''' + doi('10.1056/NEJMoa2500969') + '''<br>[2] Plotkin M et al. Diabetes Obes Metab 2026. ''' + doi('10.1111/dom.70911') + '''</span>
  </div>
  <div style="padding: 0 14px 9px; font-size: 12px; color: #6E47D1;">Changed from chat · <a href="#">Undo</a></div>
</div>'''
actions = '<div style="display: flex; gap: 8px;">' + btn('Send back', '#') + btn('Sign and send', 'LHome.dc.html', True) + '</div>'
tl = '<section style="display: flex; flex-direction: column;">' + \
  step(1, 'Read the enquiry', 'Agent · Tue 16:12', 'A GP asks if oral semaglutide 25 mg works as well as the weekly injection for weight') + \
  step(2, 'Find the evidence', 'Agent · Tue 16:14', 'Used the page <a href="LBoard.dc.html">Weight loss</a> and 1 paper from PubMed') + \
  step(3, 'Draft the reply', 'Agent · Tue 16:15', '') + \
  step(4, 'Medical review and signature', 'Leah Park · due Fri 5 June', '', 'wait', letter + actions) + \
  step(5, 'Send and file', 'System', '', 'todo') + '</section>'
inner = title('Dr Ruth Adeyemi: oral semaglutide 25 mg vs the injection', 'A run of <a href="LPlaybook.dc.html">Answer an enquiry</a> · arrived Tue 2 June') + tl
W['LRun'] = app('A run', 'active="waiting" ' + SB, chat('Reply to Dr Adeyemi', msgs, 'Ask about this reply', 'reply', (), 'lq5'), main('Waiting for you  ›  Sign a reply to a doctor', inner, '6px 28px 20px'))

# ---------- Records: the paper library ----------
msgs = [me('If ATTAIN-2 were corrected, what would we need to check?'),
  ai(p('Three pages and one sent reply use it:'),
     ul('<a href="LBoard.dc.html">Weight loss</a>: the chart and the trials table', '<strong>Type 2 diabetes</strong>: the headline', '<strong>Pipeline watch</strong>: one line', 'The reply to <strong>Dr Mei Lin</strong>, sent Tue'),
     p('If PubMed shows a correction, the Monday refresh flags all four in Waiting for you.'))]
cols_note = '<div style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #43239E;"><span style="padding: 3px 8px; border-radius: 6px; background: #F5F1FF;">Added from chats on pages: People, Weeks, Weight change</span><span style="color: #6B6B72;">Each cell links to its sentence</span></div>'
def pp(t, sub):
    return f'<span style="display: flex; flex-direction: column;"><span style="font-weight: 500;">{t}</span><span style="font-size: 12px; color: #6B6B72;">{sub}</span></span>'
lib = table('1.5fr 96px 56px 50px 124px 1fr', ['Paper', 'Journal', 'People', 'Weeks', 'Weight change', 'Used by'], [
  [pp('OASIS 1', 'Oral semaglutide 50 mg'), 'Lancet 2023', '667', '68', '−15.1% vs −2.4%', '2 pages'],
  [pp('OASIS 2', 'East Asian adults'), 'JAMA IM 2025', '201', '68', '−14.3% vs −1.3%', '2 pages'],
  [pp('OASIS 4', 'Oral semaglutide 25 mg'), 'NEJM 2025', '307', '64', '−13.6% vs −2.2%', '2 pages, 1 reply'],
  [pp('ATTAIN-1', 'Orforglipron'), 'NEJM 2025', '3,127', '72', '−11.2% vs −2.1%', '2 pages'],
  {'href': 'LPaper.dc.html', 'cells': [pp('ATTAIN-2', 'Orforglipron, with T2D'), 'Lancet 2025', '1,613', '72', '−9.6% vs −2.5%', '3 pages, 1 reply'], 'style': ' background: #FBF9FF;'},
  [pp('ATTAIN-MAINTAIN', 'After injections'), 'Nat Med 2026', '376', '52', mute('n/a'), '1 page'],
  [pp('Oral vs injected', 'Indirect comparison'), 'DOM 2026', mute('n/a'), mute('n/a'), mute('n/a'), '1 page, 1 reply'],
  [pp('Cognition in depression', 'Oral semaglutide 14 mg'), 'Med 2025', '72', '16', mute('n/a'), mute('Left out')]], '13px')
inner = title('Papers <span style="color: #6B6B72; font-weight: 400;">214</span>', 'Every paper this project has read. Each is read once and reused by every page and reply.') + \
  '<div style="display: flex; gap: 8px; font-size: 13px;"><span style="padding: 5px 11px; border-radius: 999px; background: #1C1C1E; color: #FFFFFF;">On a page 31</span><span style="padding: 5px 11px; border-radius: 999px; background: #F4F4F6;">In a reply 12</span><span style="padding: 5px 11px; border-radius: 999px; background: #F4F4F6;">All 214</span><span style="flex: 1 1 auto;"></span><span style="padding: 5px 11px; border-radius: 8px; border: 1px solid #E5E5EA;">List ⌄</span></div>' + \
  cols_note + lib + '<span style="font-size: 12.5px; color: #6B6B72;">Showing 8 of 31</span>'
W['LLibrary'] = app('Papers', 'active="lr-papers" ' + SB, chat('Papers', msgs, 'Ask about these papers', 'list', (), 'lq6'), main('Records  ›  Papers', inner, '6px 28px 20px'))

# ---------- A paper's page ----------
msgs = [me('Is the −9.6% the treatment-regimen estimand or the efficacy one?'),
  ai(p('Treatment regimen. The abstract says it is the primary estimand and uses <em>"data from all randomly assigned participants, regardless of intercurrent events"</em>.'),
     p('The efficacy estimand numbers aren\'t in the abstract. The full text is not open access, so I can\'t check them from here.'))]
facts = table('1fr 150px 1.3fr', ['Pulled from the abstract', 'Value', 'Used by'], [
  ['People randomised', num('1,613'), 'Weight loss'],
  ['Weeks', num('72'), 'Weight loss'],
  ['Weight change, 36 mg vs placebo', num('−9.6% vs −2.5%'), 'Weight loss, Type 2 diabetes'],
  ['Difference vs placebo, 36 mg', num('−7.1 (−8.2 to −6.1)'), 'Weight loss, Type 2 diabetes'],
  ['Stopped for side effects', num('6.1–9.9% vs 4.1%'), 'Side effects (draft)']], '13px')
abstract = '<div style="font-size: 13.5px; line-height: 1.6; color: #3F3F46;">… For the treatment regimen estimand, the mean percent change in bodyweight from baseline to week 72 was −5·1% with 6 mg, −7·0% with 12 mg, and ' + mark('−9·6% (−10·5 to −8·7) with 36 mg orforglipron (ETD −7·1 [−8·2 to −6·1]; p&lt;0·0001), versus −2·5% (−3·0 to −1·9) with placebo') + '. … Treatment discontinuations due to adverse events (mainly gastrointestinal-related) were ' + mark('higher for orforglipron (6·1–9·9%) versus placebo (4·1%)') + '. …</div>'
inner = title('Orforglipron for obesity in people with type 2 diabetes (ATTAIN-2)', 'Horn DB et al. Lancet 2025 · ' + doi('10.1016/S0140-6736(25)02165-8') + ' · read 4 May, once, for every page') + \
  section(h3('What we pulled from it'), facts) + section(h3('Where it says so'), abstract) + \
  section(h3('Also used in'), '<span style="font-size: 13.5px;">Reply to Dr Mei Lin, sent Tue 2 June · <a href="LPlaybook.dc.html">Answer an enquiry</a></span>')
W['LPaper'] = app('A paper', 'active="lr-papers" ' + SB, chat('ATTAIN-2', msgs, 'Ask about this paper', 'paper', (), 'lq7'), main('Records  ›  Papers  ›  ATTAIN-2', inner, '6px 28px 20px'))

# ---------- Project settings ----------
msgs = [me('Can the refresh look at ClinicalTrials.gov as well?'),
  ai(chip('Drafted: add <strong>ClinicalTrials.gov</strong> as a source'), p('Drafted. Refreshes would then also flag trials that finish or post results before they\'re published. It reads only public data, so it needs no sign-in.'), p('Leah approves source changes for this project.'))]
def tag(t, new=False):
    st = 'border: 1px dashed #9C86E8; color: #43239E; background: #FBF9FF;' if new else 'border: 1px solid #E5E5EA;'
    return f'<span style="padding: 5px 10px; border-radius: 8px; {st} font-size: 13px;">{t}</span>'
people = table('1fr 220px', ['Person', 'Role in this project'], [['Leah Park', 'Medical lead · signs replies, approves changes'], ['Omar Haddad', 'Medical information · handles enquiries'], ['<span style="color: #52525B;">4 more</span>', '<span style="color: #52525B;">Can ask and read pages</span>']])
tmpl = '<div style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 12px 14px; font-size: 13.5px;">Started from <strong>Literature</strong>, version 2 · this project added <strong>Answer an enquiry</strong></div>'
inner = title('Project settings') + section(h3('Template'), tmpl) + section(h3('People'), people) + \
  section(h3('Sources'), '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' + tag('PubMed') + tag('Our papers (shared drive)') + tag('Medical information inbox') + tag('ClinicalTrials.gov · draft', True) + '</div>') + \
  section(h3('Rules'), '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' + tag('Every number links to its sentence') + tag('Page changes are reviewed before everyone sees them') + tag('A medical lead signs every reply') + tag('Outgoing email needs approval') + '</div>')
W['LSettings'] = app('Project settings', 'active="settings" ' + SB, chat('Project settings', msgs, 'Ask about this project\'s setup', 'page', (), 'lq8'), main('Literature search  ›  Project settings', inner))


# ---------- A parent page: GLP-1 ----------
msgs = [me('Add a sub-page comparing oral semaglutide 25 mg with the weekly injection'),
  ai(chip('Drafted a sub-page: <strong>Oral vs injected semaglutide</strong>'),
     p('There\'s no head-to-head trial, so it\'s built from the indirect comparison of OASIS 4 and STEP 1, and says so at the top.'),
     p('It stays a draft until you keep it. Once kept, this page\'s summary will include it.')),
  me('What goes in the summary at the top?'),
  ai(p('Only kept sub-pages. <strong>Side effects</strong> is still a draft, so it isn\'t in the summary yet.'))]
def subcard(t, line, meta, href, draft=False):
    tagp = (' <span style="font-size: 11px; vertical-align: middle;">' + pill('Draft') + '</span>') if draft else ''
    return f'<a href="{href}" style="border: 1px solid #E5E5EA; border-radius: 10px; padding: 11px 14px; display: flex; flex-direction: column; gap: 4px; color: #1C1C1E; text-decoration: none;"><span style="font-size: 14px; font-weight: 600;">{t}{tagp}</span><span style="font-size: 13px; line-height: 1.45;">{line}</span><span style="font-size: 12px; color: #6B6B72;">{meta}</span></a>'
refresh = '<span style="flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 5px 10px; border-radius: 8px; background: #F5F1FF; color: #43239E; font-weight: 500;">↻ Sums up its sub-pages</span><span style="font-size: 12px; color: #52525B;">After each refresh · last Mon 1 June</span></span>'
subs = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">' + \
  subcard('Weight loss ↻', '9 to 13 points more than placebo; 7 in type 2 diabetes. Most weight stays off after switching from injections.', '5 trials · changed Mon 1 June', 'LBoard.dc.html') + \
  subcard('Type 2 diabetes ↻', 'ATTAIN-2: 7.1 points more weight loss than placebo at 36 mg over 72 weeks.', '1 trial · nothing new Mon', '#') + \
  subcard('Side effects', '5 to 10% stopped orforglipron because of side effects, against 3 to 4% on placebo.', 'From Omar\'s question · today', 'LAsk.dc.html', True) + \
  subcard('Oral vs injected semaglutide', 'One indirect comparison: similar weight loss, difference 1.0 points (95% CI −1.6 to 3.6).', 'Drafted from chat · just now', '#', True) + '</div>'
changes = '<div style="display: flex; flex-direction: column; gap: 4px; font-size: 13.5px;"><span><a href="LChange.dc.html">Weight loss</a>: ATTAIN-MAINTAIN added · accepted by Leah</span><span>Type 2 diabetes: nothing new</span><span>Side effects: new draft from Omar\'s question</span></div>'
inner = title('GLP-1', 'Oral GLP-1s for weight · 4 sub-pages, 2 kept up to date', refresh) + \
  p('<span style="font-size: 15px; line-height: 1.5;">Oral GLP-1s give <strong>9 to 13 points more</strong> weight loss than placebo over 64 to 72 weeks, and about <strong>7 points</strong> in people with type 2 diabetes. After switching from weekly injections, orforglipron kept most of the weight off.</span>') + \
  section(h3('Sub-pages'), subs) + section(h3('What changed this week'), changes) + \
  '<span style="font-size: 12.5px; color: #6B6B72;">31 papers under GLP-1 · <a href="LLibrary.dc.html">Open in Papers</a></span>'
W['LTopic'] = app('A page with sub-pages', 'active="lp-glp" draft="true" ' + SB, chat('GLP-1', msgs, 'Ask about GLP-1, or ask for a new sub-page', 'page', ('PubMed',), 'lq9'), main('Pages  ›  GLP-1', inner, '6px 28px 20px'))

for k, v in W.items():
    open(f'project/{k}.dc.html', 'w').write(v)
print(list(W))
