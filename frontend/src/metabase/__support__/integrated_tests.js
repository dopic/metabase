/* global process, jasmine */

/**
 * Import this file before other imports in integrated tests
 */

import { format as urlFormat } from "url";
import api from "metabase/lib/api";
import { SessionApi } from "metabase/services";
import { METABASE_SESSION_COOKIE } from "metabase/lib/cookies";
import reducers from 'metabase/reducers-main';

import React from 'react'
import { Provider } from 'react-redux';

import { createMemoryHistory } from 'history'
import { getStore } from "metabase/store";
import { createRoutes, match, Router, useRouterHistory, withRouter } from "react-router";
import _ from 'underscore';

// Importing isomorphic-fetch sets the global `fetch` and `Headers` objects that are used here
import fetch from 'isomorphic-fetch';

// Mocks in a separate file as they would clutter this file
import "./integrated_tests_mocks";
import { refreshSiteSettings } from "metabase/redux/settings";
import { getRoutes } from "metabase/routes";

let loginSession = null; // Stores the current login session
let simulateOfflineMode = false;

/**
 * Login to the Metabase test instance with default credentials
 */
export async function login() {
    loginSession = await SessionApi.create({ username: "bob@metabase.com", password: "12341234"});
}

/**
 * Calls the provided function while simulating that the browser is offline.
 */
export async function whenOffline(callWhenOffline) {
    simulateOfflineMode = true;
    return callWhenOffline()
        .then((result) => {
            simulateOfflineMode = false;
            return result;
        })
        .catch((e) => {
            simulateOfflineMode = false;
            throw e;
        });
}


// Patches the metabase/lib/api module so that all API queries contain the login credential cookie.
// Needed because we are not in a real web browser environment.
api._makeRequest = async (method, url, headers, requestBody, data, options) => {
    const headersWithSessionCookie = {
        ...headers,
        ...(loginSession ? {"Cookie": `${METABASE_SESSION_COOKIE}=${loginSession.id}`} : {})
    }

    const fetchOptions = {
        credentials: "include",
        method,
        headers: new Headers(headersWithSessionCookie),
        ...(requestBody ? { body: requestBody } : {})
    };

    let isCancelled = false
    if (options.cancelled) {
        options.cancelled.then(() => {
            isCancelled = true;
        });
    }
    const result = simulateOfflineMode
        ? { status: 0, responseText: '' }
        : (await fetch(api.basename + url, fetchOptions));

    if (isCancelled) {
        throw { status: 0, data: '', isCancelled: true}
    }

    let resultBody = null
    try {
        resultBody = await result.text();
        // Even if the result conversion to JSON fails, we still return the original text
        // This is 1-to-1 with the real _makeRequest implementation
        resultBody = JSON.parse(resultBody);
    } catch (e) {}


    if (result.status >= 200 && result.status <= 299) {
        return resultBody
    } else {
        const error = { status: result.status, data: resultBody, isCancelled: false }
        if (!simulateOfflineMode) {
            console.log('A request made in a test failed with the following error:');
            console.dir(error, { depth: null });
            console.log(`The original request: ${method} ${url}`);
            if (requestBody) console.log(`Original payload: ${requestBody}`);
        }
        throw error
    }
}

// Set the correct base url to metabase/lib/api module
if (process.env.E2E_HOST) {
    api.basename = process.env.E2E_HOST;
} else {
    console.log(
        'Please use `yarn run test-integrated` or `yarn run test-integrated-watch` for running integration tests.'
    )
    process.quit(0)
}

/**
 * Creates an augmented Redux store for testing the whole app including browser history manipulation. Includes:
 * - A simulated browser history that is used by react-router
 * - Methods for
 *     * manipulating the browser history
 *     * waiting until specific Redux actions have been dispatched
 *     * getting a React container subtree for the current route
 */

export const createTestStore = () => {

    const history = useRouterHistory(createMemoryHistory)();
    const store = getStore(reducers, history, undefined, (createStore) => testStoreEnhancer(createStore, history));
    store.setFinalStoreInstance(store);
    store.dispatch(refreshSiteSettings());
    return store;
}

const testStoreEnhancer = (createStore, history) => {
    return (...args) => {
        const store = createStore(...args);

        const testStoreExtensions = {
            _originalDispatch: store.dispatch,
            _onActionDispatched: null,
            _triggeredActions: [],
            _finalStoreInstance: null,

            setFinalStoreInstance: (finalStore) => {
                store._finalStoreInstance = finalStore;
            },

            dispatch: (action) => {
                const result = store._originalDispatch(action);
                store._triggeredActions = store._triggeredActions.concat([action]);
                if (store._onActionDispatched) store._onActionDispatched();
                return result;
            },

            /**
             * Waits until all actions with given type identifiers have been called or fails if the maximum waiting
             * time defined in `timeout` is exceeded.
             *
             * Convenient in tests for waiting specific actions to be executed after mounting a React container.
             */
            waitForActions: (actionTypes, {timeout = 2000} = {}) => {
                actionTypes = Array.isArray(actionTypes) ? actionTypes : [actionTypes]

                const allActionsAreTriggered = () => _.every(actionTypes, actionType =>
                    store._triggeredActions.filter((action) => action.type === actionType).length > 0
                );

                if (allActionsAreTriggered()) {
                    // Short-circuit if all action types are already in the history of dispatched actions
                    return;
                } else {
                    return new Promise((resolve, reject) => {
                        store._onActionDispatched = () => {
                            if (allActionsAreTriggered()) resolve()
                        };
                        setTimeout(() => {
                            store._onActionDispatched = null;
                            return reject(
                                new Error(
                                    `Actions ${actionTypes.join(", ")} were not dispatched within ${timeout}ms. ` +
                                    `Dispatched actions so far: ${store._triggeredActions.map((a) => a.type).join(", ")}`
                                )
                            )
                        }, timeout)
                    });
                }
            },

            pushPath: (path) => history.push(path),
            getPath: () => urlFormat(history.getCurrentLocation()),

            connectContainer: (reactContainer) => {
                // exploratory approach, not sure if this can ever work:
                // return store._connectWithStore(reactContainer)
                const routes = createRoutes(getRoutes(store._finalStoreInstance))
                return store._connectWithStore(
                    <Router
                        routes={routes}
                        history={history}
                        render={(props) => React.cloneElement(reactContainer, props)}
                    />
                );
            },

            getAppContainer: () => {
                store._connectWithStore(
                    <Router history={history}>
                        {getRoutes(store._finalStoreInstance)}
                    </Router>
                )
            },

            _connectWithStore: (reactContainer) =>
                <Provider store={store._finalStoreInstance}>
                    {reactContainer}
                </Provider>

        }

        return Object.assign(store, testStoreExtensions);
    }
}

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;
