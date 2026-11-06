export interface BackendEvent {
  readonly message?: string;
}

export interface BackendResponse {
  readonly statusCode: number;
  readonly body: string;
}

export async function handler(event: BackendEvent = {}): Promise<BackendResponse> {
  return {
    statusCode: 200,
    body: JSON.stringify({
      component: "app",
      message: event.message ?? "Incident Triage application backend is ready",
    }),
  };
}
