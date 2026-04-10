import { google, type drive_v3 } from 'googleapis';
import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export interface GoogleDriveConnectorConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
}

export class GoogleDriveConnector implements SourceConnector {
  name = 'google_drive';
  private drive: drive_v3.Drive;
  private auth: InstanceType<typeof google.auth.OAuth2>;

  constructor(config: GoogleDriveConnectorConfig) {
    this.auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    if (config.accessToken || config.refreshToken) {
      this.auth.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
      });
    }
    this.drive = google.drive({ version: 'v3', auth: this.auth });
  }

  getAuth(): InstanceType<typeof google.auth.OAuth2> {
    return this.auth;
  }

  async fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]> {
    const query = buildDriveQuery(boundary, params);
    const maxResults = (params?.limit as number) ?? 50;

    const listResponse = await this.drive.files.list({
      q: query || undefined,
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink, owners)',
    });

    const files = listResponse.data.files ?? [];
    return files.map(mapDriveFile);
  }

  async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
    switch (actionType) {
      case 'create_file':
        return this.createFile(actionData);
      case 'delete_file':
        return this.deleteFile(actionData);
      case 'upload_file':
        return this.uploadFile(actionData);
      case 'search_files':
        return this.searchFiles(actionData);
      default:
        return { success: false, message: `Unknown action type: ${actionType}` };
    }
  }

  private async createFile(data: Record<string, unknown>): Promise<ActionResult> {
    const name = data.name as string;
    const mimeType = data.mimeType as string;
    const parents = data.parents as string[];

    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType,
        parents,
      },
    });

    return {
      success: true,
      message: `File created: ${res.data.name}`,
      resultData: { fileId: res.data.id },
    };
  }

  private async deleteFile(data: Record<string, unknown>): Promise<ActionResult> {
    const fileId = data.fileId as string;
    await this.drive.files.delete({ fileId });
    return { success: true, message: 'File deleted' };
  }

  private async uploadFile(data: Record<string, unknown>): Promise<ActionResult> {
    const name = data.name as string;
    const content = data.content as string;
    const mimeType = (data.mimeType as string) || 'text/plain';
    const parents = data.parents as string[];

    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType,
        parents,
      },
      media: {
        mimeType,
        body: content,
      },
    });

    return {
      success: true,
      message: `File uploaded: ${res.data.name}`,
      resultData: { fileId: res.data.id },
    };
  }

  private async searchFiles(data: Record<string, unknown>): Promise<ActionResult> {
    const query = data.query as string;
    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink, owners)',
    });

    return {
      success: true,
      message: `Found ${res.data.files?.length || 0} files`,
      resultData: { files: res.data.files },
    };
  }
}

function buildDriveQuery(boundary: SourceBoundary, params?: Record<string, unknown>): string {
  const parts: string[] = [];
  if (boundary.after) {
    parts.push(`modifiedTime > '${boundary.after}'`);
  }
  if (params?.query) {
    parts.push(params.query as string);
  }
  return parts.join(' and ');
}

function mapDriveFile(file: drive_v3.Schema$File): DataRow {
  return {
    source: 'google_drive',
    source_item_id: file.id ?? '',
    type: 'file',
    timestamp: file.modifiedTime ?? new Date().toISOString(),
    data: {
      name: file.name,
      title: file.name,
      mimeType: file.mimeType,
      size: file.size,
      url: file.webViewLink,
      author_name: file.owners?.[0]?.displayName ?? '',
      owners: file.owners?.map((o) => o.displayName).join(', '),
    },
  };
}
