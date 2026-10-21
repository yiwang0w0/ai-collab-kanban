package service_test

import (
	"context"
	"encoding/json"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolTurnEndRecorder interface {
	ObservePoolTurnEnd(context.Context, runsmodels.PoolExecutionActivity, bool) (*runsmodels.RunEvent, error)
}

func poolTurnEndRecorderFor(t *testing.T, service any) poolTurnEndRecorder {
	t.Helper()
	recorder, supported := service.(poolTurnEndRecorder)
	if !supported {
		t.Fatal("原生运行服务缺少精确回合结束观察入口")
	}
	return recorder
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-002.4
func TestPoolTurnEndPreservesClaimAndNeverInventsWorkOrCompletesTask(t *testing.T) {
	for _, agentType := range []string{"claude-acp", "codex-acp", "codex-app-server"} {
		for _, failed := range []bool{false, true} {
			t.Run(agentType+map[bool]string{false: "/completed", true: "/failed"}[failed], func(t *testing.T) {
				f, identity, activity := poolActivityFixture(t, agentType)
				recorder := poolTurnEndRecorderFor(t, f.svc)
				activity.StartedSource = ""
				ctx := context.Background()
				first, err := recorder.ObservePoolTurnEnd(ctx, activity, failed)
				require.NoError(t, err)
				require.NotNil(t, first)
				require.Equal(t, runsmodels.RunEventType("pool.turn-ended.v1"), first.EventType)
				var receipt struct {
					runsmodels.PoolExecutionIdentity
					Outcome string `json:"outcome"`
				}
				require.NoError(t, json.Unmarshal([]byte(first.Payload), &receipt))
				require.Equal(t, identity.ClaimID, receipt.ClaimID)
				require.Equal(t, map[bool]string{false: "completed", true: "failed"}[failed], receipt.Outcome)
				replayed, err := recorder.ObservePoolTurnEnd(ctx, activity, failed)
				require.NoError(t, err)
				require.Equal(t, first, replayed, "重放保留第一次观察时刻")
				events, err := f.runs.ListRunEvents(ctx, identity.RunID, -1, 20)
				require.NoError(t, err)
				require.Len(t, events, 4)
				for _, event := range events {
					require.NotEqual(t, runsmodels.RunEventType(runsmodels.PoolWorkObserved), event.EventType)
				}
				current, err := f.runs.GetRunByID(ctx, identity.RunID)
				require.NoError(t, err)
				require.Equal(t, runsmodels.RunStatusClaimed, current.Status)
				require.Nil(t, current.FinishedAt, "回合结束不证明执行或 checkout 已停止")
				task, err := f.tasks.GetTask(ctx, identity.TaskID)
				require.NoError(t, err)
				require.Equal(t, f.task.State, task.State)
				require.True(t, f.task.UpdatedAt.Equal(task.UpdatedAt), "回合观察不能代替主卡完成动作")
				activity.StartedSource = runsmodels.PoolStartAssistant
				work, err := f.svc.ObservePoolActivity(ctx, activity)
				require.NoError(t, err)
				require.NotNil(t, work, "更晚处理的同轮次工作证据不能被终结通知吞掉")
				require.Greater(t, work.Seq, first.Seq)
			})
		}
	}
}
