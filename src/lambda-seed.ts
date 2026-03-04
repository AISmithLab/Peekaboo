/**
 * CloudFormation custom resource handler — placeholder for future
 * seed operations. User accounts are created through the GUI.
 */

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  ResourceProperties: Record<string, string>;
}

export const handler = async (event: CfnEvent): Promise<void> => {
  // No-op — user accounts are created through the GUI on first visit
  const body = JSON.stringify({
    Status: 'SUCCESS',
    Reason: 'OK',
    PhysicalResourceId: event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  });

  await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'Content-Type': '' },
    body,
  });
};
