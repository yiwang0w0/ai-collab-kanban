package orchestrator

import (
	"context"

	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
)

// StartPoolTask 不接收用户自报身份，只有此宿主入口能把原生领取交给启动路径。
func (s *Service) StartPoolTask(ctx context.Context, claim *runsmodels.ClaimedRun) (*executor.TaskExecution, error) {
	request, err := claim.PoolStartRequest()
	if err != nil {
		return nil, err
	}
	return s.startTask(ctx, request.Release.TaskID, request.Release.AgentProfileID, models.ExecutorIDWorktree, "", "", "",
		request.Release.WorkflowStepID, false, false, nil, startTaskOptions{ProfileExplicit: true,
			WorkflowEntryID: request.Release.EntryID, Origin: launchOriginAutomatic, poolClaim: &request})
}

func (s *Service) admitTaskStartCapacity(ctx context.Context, taskID string, origin launchOrigin, payload map[string]interface{}, claim *runsmodels.PoolClaimStart) (*seam1Reservation, bool, error) {
	if claim == nil {
		return s.admitOrDeferSeam1(ctx, taskID, origin, payload)
	}
	return s.admitStartCapacity(ctx, taskID, launchOriginAutomatic, nil, false)
}
