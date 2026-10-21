package service

import "errors"

// 池发布入口完成原生阶段与真人确认校验前，通用入口不能签发池身份。
var ErrReservedPoolDispatchKey = errors.New("pool_dispatch_key_reserved_for_host")
