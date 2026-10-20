/**
 * LabelsSettingsPage
 *
 * Displays workspace label configuration in two data tables:
 * 1. Label Hierarchy - tree table with expand/collapse showing all labels
 * 2. Auto-Apply Rules - flat table showing all regex rules across labels
 *
 * Each section has an Edit button that opens an EditPopover for AI-assisted editing
 * of the underlying labels/config.json file.
 *
 * Data is loaded via the useLabels hook which subscribes to live config changes.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { getDocUrl } from '@memwise/shared/docs/doc-links'
import { Spinner } from '@memwise/ui'
import { useAppShellContext, useActiveWorkspace } from '@/context/AppShellContext'
import { useLabels } from '@/hooks/useLabels'
import {
  LabelsDataTable,
  AutoRulesDataTable,
} from '@/components/info'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
} from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'labels',
}

export default function LabelsSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const activeWorkspace = useActiveWorkspace()
  const { labels, isLoading } = useLabels(activeWorkspaceId)

  // Resolve edit configs using the workspace root path
  const rootPath = activeWorkspace?.rootPath || ''
  const labelsEditConfig = getEditConfig('edit-labels', rootPath)
  const autoRulesEditConfig = getEditConfig('edit-auto-rules', rootPath)

  // Secondary action: open the labels config file directly in system editor
  const editFileAction = rootPath ? {
    label: t("common.editFile"),
    filePath: `${rootPath}/labels/config.json`,
  } : undefined

  return (
    <SettingsPage
      title={t("settings.labels.title")}
      description={t("settings.labels.description")}
      actions={<HeaderMenu route={routes.view.settings('labels')} />}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="text-lg text-tertiary" />
        </div>
      ) : (
        <>
          {/* About Section */}
          <SettingsSection title={t("settings.labels.aboutLabels")}>
            <SettingsCard className="px-3.5 py-3">
              <div className={settingsUI.prose}>
                <p>
                  {t("settings.labels.aboutText1")}
                </p>
                <p>
                  {t("settings.labels.aboutText2")}
                </p>
                <p>
                  {t("settings.labels.aboutText3")}
                </p>
                <p>
                  <button
                    type="button"
                    onClick={() => window.electronAPI?.openUrl(getDocUrl('labels'))}
                    className={settingsUI.link}
                  >
                    {t("chat.learnMore")}
                  </button>
                </p>
              </div>
            </SettingsCard>
          </SettingsSection>

          {/* Label Hierarchy Section */}
          <SettingsSection
            title={t("settings.labels.labelHierarchy")}
            description={t("settings.labels.labelHierarchyDesc")}
            action={
              <EditPopover
                trigger={<EditButton />}
                context={labelsEditConfig.context}
                example={labelsEditConfig.example}
                displayLabel={labelsEditConfig.displayLabel}
                model={labelsEditConfig.model}
                systemPromptPreset={labelsEditConfig.systemPromptPreset}
                secondaryAction={editFileAction}
              />
            }
          >
            <SettingsCard className="p-0">
              {labels.length > 0 ? (
                <LabelsDataTable
                  data={labels}
                  searchable
                  maxHeight={350}
                  fullscreen
                  fullscreenTitle={t("settings.labels.labelHierarchy")}
                />
              ) : (
                <div className="px-6 py-8 text-center">
                  <p className="text-label text-secondary">{t("settings.labels.noLabels")}</p>
                  <p className="mt-1 text-label-sm text-tertiary">
                    {t("settings.labels.noLabelsDesc")}
                  </p>
                </div>
              )}
            </SettingsCard>
          </SettingsSection>

          {/* Auto-Apply Rules Section */}
          <SettingsSection
            title={t("settings.labels.autoApplyRules")}
            description={t("settings.labels.autoApplyRulesDesc")}
            action={
              <EditPopover
                trigger={<EditButton />}
                context={autoRulesEditConfig.context}
                example={autoRulesEditConfig.example}
                displayLabel={autoRulesEditConfig.displayLabel}
                model={autoRulesEditConfig.model}
                systemPromptPreset={autoRulesEditConfig.systemPromptPreset}
                secondaryAction={editFileAction}
              />
            }
          >
            <SettingsCard className="p-0">
              <AutoRulesDataTable
                data={labels}
                searchable
                maxHeight={350}
                fullscreen
                fullscreenTitle={t("settings.labels.autoApplyRules")}
              />
            </SettingsCard>
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  )
}
