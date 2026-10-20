/**
 * Every word the page shows, in one place. The people reading them have never heard of
 * MemWise: plain, warm and short. (One language for now; a second goes beside this file.)
 */

import type { LinkRefusal } from '@memwise/defs/external'

export const S = {
  // ---- the form
  asks: (business: string) => `${business} asks you to fill in this form`,
  optional: 'optional',
  required: 'required',
  fromDocument: (doc: string) => `from ${doc}`,
  showWhere: 'Where?',
  hideWhere: 'Hide',
  readFrom: (doc: string) => `Read from ${doc}:`,
  foundIn: (doc: string) => `Found in ${doc}:`,
  useThis: 'Use this',
  commentFrom: (name: string) => `${name} wrote:`,
  noteFrom: (business: string) => `A note from ${business}:`,
  notesForYou: 'Notes for you',
  yes: 'Yes',
  no: 'No',
  choose: 'Choose…',
  identifierLike: (example: string) => `Like ${example}`,

  // ---- files
  chooseFile: 'Choose a file',
  chooseFiles: 'Choose files',
  addMore: 'Add more files',
  takePhoto: 'Take a photo',
  uploading: (name: string) => `Uploading ${name}…`,
  remove: (name: string) => `Remove ${name}`,
  fileTooBig: (name: string, max: string) => `${name} is too big. Files can be up to ${max}.`,
  tooManyFiles: (max: number) => `You can add up to ${max} files.`,
  fileType: (name: string) => `${name} can’t be added. Please use a PDF, a photo (JPEG, PNG, HEIC, WebP) or a text file.`,
  uploadFailed: (name: string) => `${name} didn’t upload. Please try again.`,
  filesHelp: 'PDFs and photos work. You can take a photo of a paper document.',

  // ---- reading documents
  readDocuments: 'Read my documents',
  readAgain: 'Read my documents again',
  reading: 'Reading your documents…',
  readHelp: 'We can fill in some answers from your documents. You can change anything.',
  filledSome: (n: number) => (n === 1 ? 'We filled in 1 answer from your documents. Please check it.' : `We filled in ${n} answers from your documents. Please check them.`),
  foundOnly: 'We found a few things in your documents. Tap “Use this” to use them.',
  foundNothing: 'We couldn’t read any answers from your documents. Please fill them in yourself.',
  readFailed: 'We couldn’t read your documents just now. You can fill in the answers yourself.',

  // ---- saving
  saving: 'Saving…',
  savedAt: (time: string) => `Saved at ${time}`,
  saveFailed: 'Not saved yet. We’ll try again.',
  savedHelp: 'Your answers are saved as you go. You can come back to this link later.',

  // ---- checks
  fillThis: 'Please fill this in.',
  pickOne: 'Please choose one.',
  addAFile: 'Please add a file.',
  badEmail: 'Please check this email address.',
  badPhone: 'Please check this phone number.',
  badNumber: 'Please enter a number, like 1200 or 1,200.50.',
  badDate: 'Please enter a date.',
  badIdentifier: (example?: string) => (example ? `This doesn’t look right. It should look like ${example}.` : 'This doesn’t look right. Please check it.'),
  fixBelow: (n: number) => (n === 1 ? 'Please check 1 answer below.' : `Please check ${n} answers below.`),

  // ---- sending
  send: (business: string) => `Send to ${business}`,
  sending: 'Sending…',
  sendFailed: 'We couldn’t send your answers. Please check your connection and try again.',
  thanks: (name?: string) => (name ? `Thank you, ${name}.` : 'Thank you.'),
  hasDetails: (business: string) => `${business} has your details.`,
  closePage: 'You can close this page now.',
  expiresOn: (date: string) => `This link works until ${date}.`,

  // ---- trouble
  offlineTitle: 'You’re offline',
  offlineBody: 'Please check your internet connection. Your answers are kept on this page until you’re back.',
  networkTitle: 'We couldn’t open the form',
  networkBody: 'Please check your connection and try again.',
  unavailableTitle: 'This form isn’t available right now',
  unavailableBody: 'Please try again in a little while.',
  tryAgain: 'Try again',
  loading: 'Loading…',
  replyForHelp: 'If you need help, reply to the message that brought you here.',

  // ---- inbox links
  forPerson: (business: string, person: string) => `${business} · for ${person}`,
  caseLabel: 'Case',
  details: 'Details',
  preview: 'What will be sent',
  to: 'To',
  subject: 'Subject',
  approve: 'Approve',
  reject: 'Don’t send',
  comment: 'Comment',
  commentRequired: 'Please say what needs to change.',
  commentHelp: 'This goes back with your answer.',
  confirmTitle: (label: string) => `${label}?`,
  confirm: (label: string) => `Yes, ${label.toLowerCase()}`,
  goBack: 'Go back',
  decided: 'Done. Your answer is recorded.',
  decidedVia: 'You can close this page. MemWise has your answer.',
  openInAppTitle: 'This one opens in MemWise',
  openInAppBody: 'It needs you to type in some details, which you can do in the MemWise app.',
  openInApp: 'Open in MemWise',
} as const

/** The page for a link that can't be used, by its status. */
export function refusalTitle(status: LinkRefusal['status']): string {
  switch (status) {
    case 'expired': return 'This link has expired'
    case 'used': return 'This form has already been sent'
    case 'closed': return 'This form is closed'
    case 'revoked': return 'This link no longer works'
    case 'not_yet': return 'This form isn’t ready yet'
    case 'rate_limited': return 'Please wait a moment'
    case 'unknown':
    default: return 'We couldn’t find this form'
  }
}

/** What to say when the server's message is missing. */
export function refusalFallback(status: LinkRefusal['status']): string {
  switch (status) {
    case 'expired': return 'Links work for a limited time. Ask for a new one and we’ll send it.'
    case 'used': return 'Your answers have already reached us. There’s nothing more to do.'
    case 'closed': return 'This form doesn’t need answers any more.'
    case 'revoked': return 'This link was turned off. If you still need to send something, ask for a new link.'
    case 'not_yet': return 'Please try again a little later.'
    case 'rate_limited': return 'There were a lot of tries in a short time. Please wait a minute and try again.'
    case 'unknown':
    default: return 'Please check that you opened the whole link from your message.'
  }
}
