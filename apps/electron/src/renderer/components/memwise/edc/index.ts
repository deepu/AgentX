/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9): EDC and a study across apps, as screens and
 * blocks the shell mounts.
 */
export { EdcHomeScreen, AlsoInOtherApps, RecordOwnedFacts, useEdcHome, useStudyApps, useLinkedRecords } from './EdcScreens'
export { EdcHomeView, AlsoInOtherAppsView, AlsoInOtherAppsList, EdcSiteBars, EdcSourceLine, EdcTiles, EdcWaitingList, type EdcHomeViewProps } from './EdcHomeView'
export { EdcProjectHome, isEdcApp, queriesPageId, type EdcProjectHomeProps } from './EdcProjectHome'
export { OwnerTag, OpenInAppButton, RecordFactsByAppView, type RecordFactsByAppViewProps } from './OwnerTags'
export { factsByApp, fieldOwner, otherApps, ownerTone, type OwnedFact, type OwnerApp } from './edc-model'
