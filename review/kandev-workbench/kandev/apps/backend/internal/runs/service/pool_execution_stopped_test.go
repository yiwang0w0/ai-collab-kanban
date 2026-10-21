package service_test

import (
	"context"
	"encoding/json"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolExecutionStopRecorder interface {
	ObservePoolExecutionStopped(context.Context, runsmodels.PoolExecutionActivity, string, string, bool) (*runsmodels.RunEvent, error)
}

func poolExecutionStopRecorderFor(t *testing.T, service any) poolExecutionStopRecorder {
	t.Helper()
	recorder, supported := service.(poolExecutionStopRecorder)
	require.True(t, supported, "共享运行服务缺少当前分配的原生停止证据入口")
	return recorder
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStoppedRecordsNativeFactWithoutInventingWorkOrReleasingClaim(t *testing.T) {
	for _, agentType := range []string{"claude-acp", "codex-acp", "codex-app-server"} {
		for _, released := range []bool{false, true} {
			t.Run(agentType+map[bool]string{false: "/pending-activity", true: "/released-activity"}[released], func(t *testing.T) {
				f, identity, activity := poolActivityFixture(t, agentType)
				activity.StartedSource, activity.OperationID = "", ""
				recorder := poolExecutionStopRecorderFor(t, f.svc)
				first, err := recorder.ObservePoolExecutionStopped(context.Background(), activity, "standalone_control_v1", "control-instance", released)
				require.NoError(t, err)
				require.NotNil(t, first)
				require.Equal(t, runsmodels.RunEventType("pool.execution-stopped.v1"), first.EventType)
				var receipt struct {
					runsmodels.PoolExecutionIdentity
					Source                    string `json:"source"`
					RuntimeInstanceID         string `json:"runtime_instance_id"`
					ExecutionActivityReleased bool   `json:"execution_activity_released"`
				}
				require.NoError(t, json.Unmarshal([]byte(first.Payload), &receipt))
				require.Equal(t, identity, receipt.PoolExecutionIdentity)
				require.Empty(t, receipt.OperationID, "停止整个原生执行不补造提供商 operation")
				require.Equal(t, "standalone_control_v1", receipt.Source)
				require.Equal(t, "control-instance", receipt.RuntimeInstanceID)
				require.Equal(t, released, receipt.ExecutionActivityReleased)
				replayed, err := recorder.ObservePoolExecutionStopped(context.Background(), activity, "standalone_control_v1", "control-instance", released)
				require.NoError(t, err)
				require.Equal(t, first, replayed)
				events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
				require.NoError(t, err)
				require.Len(t, events, 3, "只保存意图、分配与停止事实，不补开工或回合完成")
				claim, err := f.runs.ResolveCurrentPoolClaim(context.Background(), identity.RunID)
				require.NoError(t, err)
				require.Equal(t, identity.ClaimID, claim.ClaimID)
				require.Nil(t, claim.FinishedAt, "原生活动释放不是 checkout 和数据库占用释放的完整证明")
			})
		}
	}
}
