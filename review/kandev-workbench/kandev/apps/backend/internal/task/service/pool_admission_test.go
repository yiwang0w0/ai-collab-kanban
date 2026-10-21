package service

import "context"

// 任务服务包不能反向导入 orchestrator；真实锁竞争由协调器边界测试负责。
type poolTaskTestAdmission struct{}

func (poolTaskTestAdmission) WithPoolEnqueueAdmission(ctx context.Context, _ string, fn func(context.Context, bool) error) error {
	return fn(ctx, false)
}

func (poolTaskTestAdmission) WithPoolReleaseAdmission(ctx context.Context, _ string, fn func(context.Context) error) error {
	return fn(ctx)
}
