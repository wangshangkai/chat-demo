import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { mergeHistory, replaceHistory, useChatStore, type MergeHistoryResult } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

export const RECENT_HISTORY_HOURS = 72
const HOUR_MS = 60 * 60 * 1000

// 导入、导出、同一文件同步与全部删除串行处理，避免读取归档时数据被清空或两个事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`
const recentBackupFileName = (date: Date) => `deepseek_data-3d-${formatDate(date)}.zip`

export type ExportHistoryOptions = {
  /** 只导出该时间范围内更新的会话；缺省导出全部。 */
  hours?: number
  /** 自定义下载文件名；缺省按导出范围生成。 */
  name?: string
}

export type ExportedHistory = {
  name: string
  blob: Blob
  count: number
}

const exportHistoryTask = async (options: ExportHistoryOptions = {}): Promise<ExportedHistory> => {
  // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
  const { sessions, sessionCache } = useChatStore.getState()
  const cutoff = options.hours === undefined ? undefined : Date.now() - options.hours * HOUR_MS
  const selected =
    cutoff === undefined ? sessions : sessions.filter((summary) => summary.updatedAt >= cutoff)
  async function* readSessions(): AsyncGenerator<Session> {
    for (const summary of selected) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      if (!session) {
        throw new Error(`History session disappeared during export: ${summary.id}`)
      }
      // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
      yield { ...session, ...summary }
    }
  }
  const { exportArchive } = await import('./history/exportArchive.js')
  const now = new Date()
  const blob = await exportArchive(readSessions())
  return {
    name:
      options.name ??
      (options.hours === undefined ? backupFileName(now) : recentBackupFileName(now)),
    blob,
    count: selected.length,
  }
}

/** 导出为历史会话导出格式的 ZIP，可再次导入；可限制时间范围或指定文件名。 */
export const exportHistory = (options: ExportHistoryOptions = {}): Promise<ExportedHistory> =>
  enqueueBackup(() => exportHistoryTask(options))

const importHistoryTask = async (file: File): Promise<MergeHistoryResult> => {
  const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
  await checkArchiveFormat(file)
  return mergeHistory(() => importArchive(file))
}

/**
 * 确认导入后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，再合并到现有会话，保留本地较新的版本。
 */
export const importHistory = (file: File): Promise<MergeHistoryResult> =>
  enqueueBackup(() => importHistoryTask(file))

export type SyncHistoryOptions = {
  serverUrl: string
  fileId: string
  /** 同步窗口，缺省为最近 72 小时。 */
  hours?: number
}

export type SyncHistoryResult = {
  /** 云端文件存在时，本次合并的结果；云端无文件时为 null。 */
  imported: MergeHistoryResult | null
  /** 本次上传的会话数。 */
  exported: number
  uploaded: boolean
}

/** 云端数据已合并，但覆盖上传失败。 */
export class SyncUploadError extends Error {
  constructor(readonly exported: number) {
    super('Failed to upload synced history archive')
    this.name = 'SyncUploadError'
  }
}

const syncHistoryTask = async (options: SyncHistoryOptions): Promise<SyncHistoryResult> => {
  const { downloadSyncArchive, uploadSyncArchive } = await import('../sync/remote.js')
  const remote = await downloadSyncArchive(options)
  const imported = remote
    ? await importHistoryTask(
        new File([remote], `${options.fileId.trim()}.zip`, { type: 'application/zip' })
      )
    : null
  const exported = await exportHistoryTask({
    hours: options.hours ?? RECENT_HISTORY_HOURS,
    name: `${options.fileId.trim()}.zip`,
  })
  // 云端已有文件时，即使没有会话也上传空快照，让过期会话自然从云端消失。
  const uploaded = remote !== null || exported.count > 0
  if (uploaded) {
    try {
      await uploadSyncArchive(options, exported.blob)
    } catch {
      throw new SyncUploadError(exported.count)
    }
  }
  return { imported, exported: exported.count, uploaded }
}

/** 拉取云端 ZIP 并合并，再上传本地最近时间窗口内的会话。 */
export const syncHistory = (options: SyncHistoryOptions): Promise<SyncHistoryResult> =>
  enqueueBackup(() => syncHistoryTask(options))

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
