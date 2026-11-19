export type SyncRemoteConfig = {
  serverUrl: string
  fileId: string
}

/** 同步文件 ID 同时用作上传下载的文件名，限制为安全的 ASCII 片段。 */
export const isValidSyncFileId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim())

export const isValidSyncServerUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

const baseUrl = (value: string): string => {
  if (!isValidSyncServerUrl(value)) {
    throw new Error('Invalid sync server URL')
  }
  return new URL(value.trim()).href.replace(/\/+$/, '')
}

const fileName = (fileId: string): string => {
  if (!isValidSyncFileId(fileId)) {
    throw new Error('Invalid sync file ID')
  }
  return `${fileId.trim()}.zip`
}

/** 下载云端 ZIP；云端还没有该文件时返回 null。 */
export const downloadSyncArchive = async (config: SyncRemoteConfig): Promise<Blob | null> => {
  const url = `${baseUrl(config.serverUrl)}/files/${encodeURIComponent(fileName(config.fileId))}`
  const response = await fetch(url, { cache: 'no-store' })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Failed to download sync archive: ${response.status}`)
  }
  return response.blob()
}

/** 覆盖上传云端同名 ZIP。 */
export const uploadSyncArchive = async (config: SyncRemoteConfig, blob: Blob): Promise<void> => {
  const form = new FormData()
  form.append('file', blob, fileName(config.fileId))
  const response = await fetch(`${baseUrl(config.serverUrl)}/upload`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) {
    throw new Error(`Failed to upload sync archive: ${response.status}`)
  }
}
