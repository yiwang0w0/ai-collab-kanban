package pluginsdk

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
)

func (h *exactHostFixture) ReadTaskCompletionGate(_ context.Context, query TaskCompletionGateRead) (*TaskCompletionGate, error) {
	return &TaskCompletionGate{TaskID: query.TaskID, WorkspaceID: query.WorkspaceID, Revision: 9, Blocked: true, Criteria: []TaskCompletionCriterion{{ID: "fleet.acceptance", Description: "等待验收"}}}, nil
}

func TestCompletionGateReadRoundTrip(t *testing.T) {
	host := dialHostOverBufconn(t, &exactHostFixture{})
	reader, ok := HostTaskCompletionGateReader(host)
	require.True(t, ok, "客户端缺少只读门禁接口")
	gate, err := reader.ReadTaskCompletionGate(context.Background(), TaskCompletionGateRead{RequestID: "read-1", WorkspaceID: "workspace-1", TaskID: "task-1"})
	require.NoError(t, err)
	require.Equal(t, int64(9), gate.Revision)
	require.Equal(t, "task-1", gate.TaskID)
	require.Equal(t, "fleet.acceptance", gate.Criteria[0].ID)
}
