package backendapp

import (
	"context"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// ProcessPoolRun 复用共享领取结果，不另建队列，也不把进程启动返回当作任务完成。
func (a *officeOrchestratorTaskStarter) ProcessPoolRun(ctx context.Context, claim *runsmodels.ClaimedRun) error {
	if claim != nil {
		if request, err := claim.PoolStartRequest(); err == nil {
			a.orch.ObservePoolCommit(runsmodels.PoolProjectionCommit{TaskID: request.Release.TaskID,
				RunID: claim.ID, ClaimID: claim.ClaimID, Sequence: -1, Kind: "claimed"})
		}
	}
	_, err := a.orch.StartPoolTask(ctx, claim)
	return err
}
