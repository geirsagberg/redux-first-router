// @flow
import type { RoutesMapInput, Options, Store, Dispatch } from '../flow-types'
import { compose, createHistory, createReducer, createInitialState, createRequest } from './index'

import {
  createSelector,
  formatRoutes,
  shouldTransition
} from '../utils'

import {
  serverRedirect,
  pathlessRoute,
  anonymousThunk,
  transformAction,
  call,
  enter,
  changePageTitle
} from '../middleware'

import { onError as defaultOnError } from '../middleware/call/utils'

export default (
  routesInput: RoutesMapInput = {},
  options: Options = {},
  middlewares: Array<Function> = [
    serverRedirect,       // short-circuiting middleware
    anonymousThunk,
    pathlessRoute('thunk'),
    transformAction,      // pipeline starts here
    call('beforeLeave', { prev: true }),
    call('beforeEnter'),
    enter,
    changePageTitle,
    call('onLeave', { prev: true }),
    call('onEnter'),
    call('thunk', { cache: true }),
    call('onComplete')
  ]
) => {
  const {
    location,
    title,
    formatRoute,
    createHistory: createSmartHistory = createHistory,
    createReducer: createLocationReducer = createReducer,
    createInitialState: createState = createInitialState,
    onError: onErr
  } = options

  // assign to options so middleware can override them in 1st pass if necessary
  options.shouldTransition = options.shouldTransition || shouldTransition
  options.createRequest = options.createRequest || createRequest
  options.compose = options.compose || compose
  options.onError = typeof onErr !== 'undefined' ? onErr : defaultOnError

  const routes = formatRoutes(routesInput, formatRoute)
  const selectLocationState = createSelector('location', location)
  const selectTitleState = createSelector('title', title)
  const history = createSmartHistory(options)
  const { nextHistory: nh } = history.firstRoute
  const initialState = createState(routes, nh, options)
  const reducer = createLocationReducer(initialState, routes, nh, options)
  const wares = {}
  const register = (name: string, val?: any = true) => wares[name] = val
  const has = (name: string) => wares[name]
  const ctx = { busy: false }
  const api = { routes, history, options, register, has, ctx }
  const onError = call('onError')(api)
  const nextPromise = options.compose(middlewares, api, true)

  const middleware = (store: Store) => {
    const getTitle = () => selectTitleState(store.getState() || {})
    const getLocation = (s) => selectLocationState(s || store.getState() || {})
    const { shouldTransition, createRequest } = options // middlewares may mutably monkey-patch these in above call to `compose`

    Object.assign(api, { store, getTitle, getLocation })
    store.getState.rudy = api // make rudy available via `context` with no extra Providers, (see <Link />)
    history.listen(store.dispatch) // dispatch actions in response to browser back/next buttons, etc

    return (dispatch: Dispatch) => (action: Object) => {
      if (!shouldTransition(action, api)) return dispatch(action) // short-circuit and pass through Redux middleware normally
      if (action.tmp && action.tmp.cancelled) return Promise.resolve(action)

      const req = createRequest(action, api, dispatch) // the `Request` arg passed to all middleware
      const mw = req.route.middleware
      const next = mw ? options.compose(mw, api, !!req.route.path) : nextPromise

      return next(req) // start middleware pipeline
        .catch(error => {
          req.error = error
          req.errorType = `${req.action.type}_ERROR`
          return onError(req)
        })
        .then(res => {
          const isRouteChangingPipeline = req.route.path && !req.tmp.cancelled && !req.clientLoadBusy
          req.ctx.busy = isRouteChangingPipeline ? false : req.ctx.busy
          return res
        })
    }
  }

  return {
    ...api,
    middleware,
    reducer,
    firstRoute: (resolveOnEnter = true) => {
      api.resolveFirstRouteOnEnter = resolveOnEnter
      return history.firstRoute
    }
  }
}