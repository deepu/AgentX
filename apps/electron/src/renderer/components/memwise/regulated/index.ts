/**
 * Stage 5 · Regulated projects (docs/memwise/26-projects-and-pages.md §7, §8): the screens the
 * shell mounts in its right column (~900px), their presentational views, and the inbox bodies.
 * The inspector's own read-only pages are the form app's (`apps/external-form`, `/v/<token>`).
 */

export {
  ChangeRequestScreen, AuditTrailScreen, InspectorSetup, TmfIndexScreen, defaultRegulatedNavigation,
  type ChangeRequestScreenProps, type AuditTrailScreenProps, type InspectorSetupProps, type TmfIndexScreenProps, type RegulatedNavigation,
} from './screens'
export { ChangeRequestView, type ChangeRequestViewProps, type ChangeRequestActions } from './ChangeRequestView'
export { AuditTrailView, type AuditTrailViewProps } from './AuditTrailView'
export { InspectorSetupView, QuestionCard, type InspectorSetupViewProps, type InspectorSetupActions } from './InspectorSetupView'
export { TmfIndexView, type TmfIndexViewProps } from './TmfIndexView'
export { ChangeRequestBody, InspectorQuestionBody } from './RegulatedInboxBodies'
export { RegulatedDomainLinks } from './RegulatedDomainLinks'
