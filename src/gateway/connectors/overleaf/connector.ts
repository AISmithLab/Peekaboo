import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export class OverleafConnector implements SourceConnector {
  name = 'overleaf';

  async fetch(_boundary: SourceBoundary, _params?: Record<string, unknown>): Promise<DataRow[]> {
    // Overleaf doesn't have a fetch API we use here, it's mostly for document creation.
    return [];
  }

  async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
    switch (actionType) {
      case 'create_document':
        return this.createDocument(actionData);
      default:
        return { success: false, message: `Unknown action type: ${actionType}` };
    }
  }

  private createDocument(data: Record<string, unknown>): ActionResult {
    const body = data.body as string;
    const title = (data.title as string) || 'document.tex';

    if (!body) {
      return { success: false, message: 'No LaTeX content provided in "body"' };
    }

    return {
      success: true,
      message: 'LaTeX document prepared for Overleaf',
      resultData: {
        type: 'overleaf_redirect',
        snip: body,
        snip_name: title.endsWith('.tex') ? title : `${title}.tex`,
      },
    };
  }
}
