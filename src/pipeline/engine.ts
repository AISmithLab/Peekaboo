import type { Manifest } from '../manifest/types.js';
import type { PipelineContext } from '../operators/types.js';
import type { DataRow, ActionResult } from '../connectors/types.js';
import { getOperator } from '../operators/registry.js';

export interface PipelineResult {
  data: DataRow[];
  actionResult?: ActionResult;
  meta: {
    operatorsApplied: string[];
    itemsFetched: number;
    itemsReturned: number;
    queryTimeMs: number;
  };
}

export async function executePipeline(
  manifest: Manifest,
  context: PipelineContext,
  _params?: Record<string, unknown>,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const operatorsApplied: string[] = [];

  // Validate: stage must be the last operator if present
  for (let i = 0; i < manifest.graph.length; i++) {
    const nodeName = manifest.graph[i];
    const opDecl = manifest.operators.get(nodeName);
    if (!opDecl) {
      throw new Error(`Pipeline error: graph references undeclared operator "${nodeName}"`);
    }
    if (opDecl.type === 'stage' && i < manifest.graph.length - 1) {
      throw new Error(`Pipeline error: "stage" operator must be the last node in the graph, but "${nodeName}" is at position ${i + 1} of ${manifest.graph.length}`);
    }
  }

  let currentData: DataRow[] = [];
  let itemsFetched = 0;
  let actionResult: ActionResult | undefined;

  for (const nodeName of manifest.graph) {
    const opDecl = manifest.operators.get(nodeName);
    if (!opDecl) {
      throw new Error(`Pipeline error: graph references undeclared operator "${nodeName}"`);
    }

    const operator = getOperator(opDecl.type);
    operatorsApplied.push(`${nodeName}:${opDecl.type}`);

    const result = await operator.execute(currentData, context, opDecl.properties);

    if (opDecl.type === 'stage') {
      // Stage returns ActionResult
      actionResult = result as ActionResult;
    } else if (Array.isArray(result)) {
      currentData = result;
      if (opDecl.type === 'pull') {
        itemsFetched = currentData.length;
      }
    }
  }

  return {
    data: currentData,
    actionResult,
    meta: {
      operatorsApplied,
      itemsFetched,
      itemsReturned: currentData.length,
      queryTimeMs: Date.now() - startTime,
    },
  };
}
