import { google, type drive_v3 } from 'googleapis';
import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export interface DriveConnectorConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
}

export class GoogleDriveConnector implements SourceConnector {
  name = 'google_drive';
  private drive: drive_v3.Drive;
  private auth: InstanceType<typeof google.auth.OAuth2>;
  private lastSyncTimestamp?: string;

  constructor(config: DriveConnectorConfig) {
    this.auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    if (config.accessToken || config.refreshToken) {
      this.auth.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
      });
    }
    this.drive = google.drive({ version: 'v3', auth: this.auth });
  }

  /**
   * Expose the underlying OAuth2 client so callers can listen for
   * the 'tokens' event (fired when tokens are auto-refreshed).
   */
  getAuth(): InstanceType<typeof google.auth.OAuth2> {
    return this.auth;
  }

  /**
   * Update the access token on the underlying OAuth2 client.
   */
  setAccessToken(token: string): void {
    this.auth.setCredentials({ ...this.auth.credentials, access_token: token });
  }

  async fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]> {
    const listParams: drive_v3.Params$Resource$Files$List = {
      pageSize: (params?.limit as number) ?? 100,
      fields: 'files(id, name, description, mimeType, webViewLink, modifiedTime, size)',
      orderBy: 'modifiedTime desc',
    };

    const queryParts: string[] = [];
    if (boundary.after) {
      queryParts.push(`modifiedTime > '${new Date(boundary.after).toISOString()}'`);
    }

    if (params?.query) {
      // Basic query for name or content
      queryParts.push(`(name contains '${params.query}' or fullText contains '${params.query}')`);
    }

    if (queryParts.length > 0) {
      listParams.q = queryParts.join(' and ');
    }

    console.log('[drive] list params:', JSON.stringify(listParams));

    const response = await this.drive.files.list(listParams);
    const files = response.data.files ?? [];
    
    return files.map(mapDriveFile);
  }

  async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
    switch (actionType) {
      case 'create_file':
        return this.createFile(actionData);
      case 'update_file':
        return this.updateFile(actionData);
      case 'delete_file':
        return this.deleteFile(actionData);
      case 'get_file_content':
        return this.getFileContent(actionData);
      default:
        return { success: false, message: `Unknown action type: ${actionType}` };
    }
  }

  async sync(boundary: SourceBoundary): Promise<DataRow[]> {
    if (this.lastSyncTimestamp) {
      boundary.after = this.lastSyncTimestamp;
    }

    const rows = await this.fetch(boundary);
    this.lastSyncTimestamp = new Date().toISOString();
    return rows;
  }

  private async createFile(data: Record<string, unknown>): Promise<ActionResult> {
    const response = await this.drive.files.create({
      requestBody: {
        name: data.name as string,
        description: data.description as string,
        mimeType: data.mimeType as string,
      },
      media: data.content ? {
        mimeType: data.mimeType as string,
        body: data.content as string,
      } : undefined,
    });

    return {
      success: true,
      message: 'File created',
      resultData: { fileId: response.data.id, webViewLink: response.data.webViewLink },
    };
  }

  private async updateFile(data: Record<string, unknown>): Promise<ActionResult> {
    const fileId = data.fileId as string;
    if (!fileId) {
      return { success: false, message: 'Missing fileId' };
    }

    const response = await this.drive.files.update({
      fileId,
      requestBody: {
        name: data.name as string,
        description: data.description as string,
      },
      media: data.content ? {
        body: data.content as string,
      } : undefined,
    });

    return {
      success: true,
      message: 'File updated',
      resultData: { fileId: response.data.id, webViewLink: response.data.webViewLink },
    };
  }

  private async deleteFile(data: Record<string, unknown>): Promise<ActionResult> {
    const fileId = data.fileId as string;
    if (!fileId) {
      return { success: false, message: 'Missing fileId' };
    }

    await this.drive.files.delete({ fileId });

    return { success: true, message: 'File deleted' };
  }

  private async getFileContent(data: Record<string, unknown>): Promise<ActionResult> {
    const fileId = data.fileId as string;
    if (!fileId) {
      return { success: false, message: 'Missing fileId' };
    }

    try {
      // First get metadata to check mimeType
      const metadata = await this.drive.files.get({ fileId, fields: 'mimeType, name' });
      const mimeType = metadata.data.mimeType;

      if (mimeType?.startsWith('application/vnd.google-apps.')) {
        // Export Google Docs/Sheets/etc to text/plain or CSV
        const exportMime = mimeType === 'application/vnd.google-apps.spreadsheet'
          ? 'text/csv'
          : 'text/plain';

        const response = await this.drive.files.export({
          fileId,
          mimeType: exportMime,
        }, { responseType: 'text' });

        return {
          success: true,
          message: 'File content exported',
          resultData: { content: response.data },
        };
      }

      // Binary files
      const response = await this.drive.files.get({
        fileId,
        alt: 'media',
      }, { responseType: 'text' });

      return {
        success: true,
        message: 'File content retrieved',
        resultData: { content: response.data },
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to get file content: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export function mapDriveFile(file: drive_v3.Schema$File): DataRow {
  return {
    source: 'google_drive',
    source_item_id: file.id ?? '',
    type: 'drive_file',
    timestamp: file.modifiedTime ?? new Date().toISOString(),
    data: {
      title: file.name ?? '(No Name)',
      name: file.name ?? '(No Name)',
      description: file.description ?? '',
      mimeType: file.mimeType ?? '',
      url: file.webViewLink ?? '',
      modifiedTime: file.modifiedTime ?? '',
      size: file.size,
    },
  };
}
