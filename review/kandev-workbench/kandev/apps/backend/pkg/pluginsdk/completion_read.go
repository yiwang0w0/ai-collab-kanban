package pluginsdk

import (
	"context"
	pluginv1 "github.com/kandev/kandev/proto/kandev/plugin/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type TaskCompletionGateRead struct{ RequestID, WorkspaceID, TaskID string }

type TaskCompletionGateReader interface {
	ReadTaskCompletionGate(context.Context, TaskCompletionGateRead) (*TaskCompletionGate, error)
}

func HostTaskCompletionGateReader(host Host) (TaskCompletionGateReader, bool) {
	reader, ok := host.(TaskCompletionGateReader)
	return reader, ok
}

func (h *grpcHostClient) ReadTaskCompletionGate(ctx context.Context, query TaskCompletionGateRead) (*TaskCompletionGate, error) {
	response, err := h.client.ReadTaskCompletionGate(ctx, &pluginv1.GetTaskExactRequest{RequestId: query.RequestID, WorkspaceId: query.WorkspaceID, TaskId: query.TaskID})
	if err != nil {
		return nil, err
	}
	if response.GetSnapshot() == nil {
		return nil, status.Error(codes.Unavailable, "门禁快照缺失")
	}
	return completionGateFromProto(response.GetSnapshot()), nil
}

func (s *grpcHostServer) ReadTaskCompletionGate(ctx context.Context, query *pluginv1.GetTaskExactRequest) (*pluginv1.TaskCompletionGateExactResponse, error) {
	reader, ok := s.impl.(TaskCompletionGateReader)
	if !ok {
		return nil, status.Error(codes.Unimplemented, "只读门禁接口不可用")
	}
	gate, err := reader.ReadTaskCompletionGate(ctx, TaskCompletionGateRead{RequestID: query.GetRequestId(), WorkspaceID: query.GetWorkspaceId(), TaskID: query.GetTaskId()})
	if err != nil {
		return nil, err
	}
	return &pluginv1.TaskCompletionGateExactResponse{Snapshot: completionGateToProto(gate)}, nil
}
