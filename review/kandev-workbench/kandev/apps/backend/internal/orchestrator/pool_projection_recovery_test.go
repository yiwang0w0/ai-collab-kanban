package orchestrator

import (
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestPoolProjectionRecoveryZeroSequenceNotSuppressedByQueue(t *testing.T) {
	svc := &Service{}
	change := runsmodels.PoolProjectionCommit{TaskID: "task", RunID: "run", Kind: "queued"}
	require.True(t, svc.acceptPoolProjectionStamp(change))
	change.Kind = "recovery"
	require.True(t, svc.acceptPoolProjectionStamp(change), "真实撤回的首个事件序号可以为零，不能被入队通知吞掉")
	require.False(t, svc.acceptPoolProjectionStamp(change), "相同恢复事件仍须去重")
}
