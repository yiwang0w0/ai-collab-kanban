package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/kandev/kandev/internal/authz"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type PoolRunQueue interface {
	QueuePoolRunAndReturn(context.Context, string, int64) (runsservice.QueueOutcome, *runsmodels.Run, error)
}

type poolReleaseReader interface {
	LoadPoolRelease(context.Context, string, int64) (runsmodels.PoolReleaseSnapshot, error)
}

// SetPoolRunQueue 仅在构造期连接共享队列；不存在第二个任务调度器。
func (s *Service) SetPoolRunQueue(queue PoolRunQueue) { s.poolRunQueue = queue }

// PublishPoolRelease 供原生阶段进入回调使用，不接受自报批准者、执行者或派发键。
func (s *Service) PublishPoolRelease(ctx context.Context, taskID, stepID, entryIdentity string) (runsservice.QueueOutcome, error) {
	if err := s.authorizeTaskScope(ctx, taskID, authz.ScopeTaskWrite); err != nil {
		return runsservice.QueueOutcomeNone, err
	}
	entryID, err := strconv.ParseInt(strings.TrimPrefix(entryIdentity, "entry:"), 10, 64)
	if err != nil || entryID <= 0 ||
		(entryIdentity != strconv.FormatInt(entryID, 10) && entryIdentity != fmt.Sprintf("entry:%020d", entryID)) || taskID == "" || stepID == "" {
		return runsservice.QueueOutcomeNone, repoerrors.ErrPoolReleaseConfirmationRequired
	}
	source, ok := s.tasks.(poolReleaseReader)
	if !ok || s.poolRunQueue == nil {
		return runsservice.QueueOutcomeNone, runsservice.ErrPoolPublisherUnavailable
	}
	release, err := source.LoadPoolRelease(ctx, taskID, entryID)
	if err != nil {
		return runsservice.QueueOutcomeNone, err
	}
	if release.TaskID != taskID || release.WorkflowStepID != stepID || release.EntryID != entryID {
		return runsservice.QueueOutcomeNone, runsservice.ErrPoolDispatchConflict
	}
	outcome, row, err := s.poolRunQueue.QueuePoolRunAndReturn(ctx, taskID, entryID)
	if err != nil {
		return runsservice.QueueOutcomeNone, err
	}
	if !release.MatchesRun(row) || (outcome != runsservice.QueueOutcomeQueued && outcome != runsservice.QueueOutcomeDeduped) {
		return runsservice.QueueOutcomeNone, runsservice.ErrPoolDispatchConflict
	}
	return outcome, nil
}
