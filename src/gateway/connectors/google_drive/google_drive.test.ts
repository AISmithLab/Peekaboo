import { describe, it, expect } from 'vitest';
import { mapDriveFile } from './connector.js';
import type { drive_v3 } from 'googleapis';

function makeDriveFile(overrides?: Partial<drive_v3.Schema$File>): drive_v3.Schema$File {
  return {
    id: 'file_123',
    name: 'Research Paper.pdf',
    description: 'A very important document',
    mimeType: 'application/pdf',
    webViewLink: 'https://drive.google.com/file/d/123/view',
    modifiedTime: '2026-03-25T14:30:00.000Z',
    size: '1024',
    ...overrides,
  };
}

describe('Google Drive Connector', () => {
  it('maps raw Drive API file to correct DataRow', () => {
    const file = makeDriveFile();
    const row = mapDriveFile(file);

    expect(row.source).toBe('google_drive');
    expect(row.source_item_id).toBe('file_123');
    expect(row.type).toBe('drive_file');
    expect(row.timestamp).toBe('2026-03-25T14:30:00.000Z');

    expect(row.data.title).toBe('Research Paper.pdf');
    expect(row.data.name).toBe('Research Paper.pdf');
    expect(row.data.description).toBe('A very important document');
    expect(row.data.mimeType).toBe('application/pdf');
    expect(row.data.url).toBe('https://drive.google.com/file/d/123/view');
    expect(row.data.modifiedTime).toBe('2026-03-25T14:30:00.000Z');
    expect(row.data.size).toBe('1024');
  });

  it('handles missing name gracefully', () => {
    const file = makeDriveFile({ name: undefined });
    const row = mapDriveFile(file);
    expect(row.data.title).toBe('(No Name)');
    expect(row.data.name).toBe('(No Name)');
  });

  it('handles missing modifiedTime gracefully', () => {
    const file = makeDriveFile({ modifiedTime: undefined });
    const row = mapDriveFile(file);
    expect(row.timestamp).toBeDefined();
  });
});
