package models

import "context"

// PoolReleaseIntent 由宿主把明确确认绑定到已解析的任务与阶段，不承载执行者或时刻自报。
type PoolReleaseIntent struct {
	TaskID                  string
	WorkspaceID             string
	WorkflowID              string
	StepID                  string
	ExpectedResourceVersion string
	ExpectedAgentProfileID  string
	ExpectedStepVersion     string
	Creating                bool
	DeferCreation           bool
	ConfirmCLIQuota         bool
}

type poolReleaseIntentKey struct{}

func WithPoolReleaseIntent(ctx context.Context, intent PoolReleaseIntent) context.Context {
	return context.WithValue(ctx, poolReleaseIntentKey{}, intent)
}

func PoolReleaseIntentFromContext(ctx context.Context) (PoolReleaseIntent, bool) {
	intent, ok := ctx.Value(poolReleaseIntentKey{}).(PoolReleaseIntent)
	return intent, ok
}
