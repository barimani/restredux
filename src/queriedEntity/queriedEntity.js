import React from 'react';
import { connect } from 'react-redux';
import {encodeAPICall, LOADING, PL} from "../helpers";
import {CFL} from "../helpers";
import {queryEntities, pushToQueue, createEntity, updateEntity, patchEntity, deleteEntity} from './queriedEntityActions';

/**
 * Queried entity abstraction (Higher Order Component)
 * Retrieves entityName, end point url and params. Dispatches queries and keeps track of the queries.
 * This component will recycles cached queries after. It retains at most RETAIN_NUMBER of queries
 * Per entityName used, there must be a reducer with the same name located at reducers/index.js
 */


// Default number of queries to cache in store
const RETAIN_NUMBER = 10;

// Default time for a valid preload (milliseconds)
const PRELOAD_VALID_TIME = 10000;

// Default time that is compared with average network time to decide whether to perform preload (milliseconds)
const SMART_THRESHOLD_TIME = 300;

// Default field that maps the results in the response body, if set to null, the whole response will be returned;
const RESULT_FIELD = 'content';

// These props should be filtered before inject
const filteredProps = {};
['queryEntities', 'pushToQueue', 'createEntity',
    'updateEntity', 'patchEntity', 'deleteEntity'].forEach(prop => filteredProps[prop] = undefined);

export default (entityName, {resultField = RESULT_FIELD, hideLoadIfDataFound = true,
    retain_number = RETAIN_NUMBER, reducer_name, preloadValidTime = PRELOAD_VALID_TIME,
    smartPreload = false, smartThresholdTime = SMART_THRESHOLD_TIME} = {}) =>
    WrappedComponent =>
        connect(state => ({[PL(entityName)]: state[reducer_name || PL(entityName)]}),
            {queryEntities, pushToQueue, createEntity, updateEntity, patchEntity, deleteEntity})(
            class extends React.Component {

                static defaultProps = {freeze: () => {}, unfreeze: () => {}};

                state = {params: {}, loadingData: false};

                // An optional function where pre loads data, argument are params, metadata and returns a new params
                // or a list of params to preload
                preLoaderFunc = undefined;

                // Sets up the query and makes the initial query
                initialQuery = (url, params = {}) => {
                    this.setState({url});
                    return this.query(params, url, true);
                };

                // Queries with the params, will construct query params based on the old ones and new ones
                query = (params = this.state.params, url = this.state.url, initial = false) => {
                    const oldParams = initial ? {...params} : {...this.state.params};
                    const newParams = {...oldParams, ...params};
                    this.setState({params: newParams, loadingData: true});
                    const data = this.props[PL(entityName)][encodeAPICall(url, newParams)];
                    if (!data || !hideLoadIfDataFound) this.props.freeze();

                    this.preload(params, url);

                    // If it should not load the data
                    if (!this.shouldLoad(data)) return Promise.resolve();

                    return this.props.queryEntities(entityName, url, newParams, !data, false, smartPreload)
                        .then(() => {this.setState({loadingData: false});this.props.unfreeze();this.collectGarbage(url, newParams);})
                        .catch(() => {this.setState({loadingData: false, params: oldParams});this.props.unfreeze();});
                };

                // Checks whether initialQuery is called and url is known
                checkSetup = () => {
                    const { url } = this.state;
                    if (!url) throw new Error(`No url specified for ${entityName}`);
                };

                // Determines whether a network call should be made to refresh
                shouldLoad = data => {
                    if (!data) return true;
                    if (data === LOADING) return false;
                    // Check whether pre-loaded less than 10 seconds ago
                    if (data.preloadedAt && ((new Date()) - data.preloadedAt) < preloadValidTime) return false;
                    return true;
                };

                // this entity does not contain id
                create = entity => {
                    this.checkSetup();
                    this.props.freeze();
                    return this.props.createEntity(entityName, entity, this.state.url)
                        .then(() => {
                            this.props.unfreeze();
                            this.query();
                        });
                };

                // Entity must contain id and the whole properties of the model
                update = entity => {
                    this.checkSetup();
                    this.props.freeze();
                    return this.props.updateEntity(entityName, entity, this.state.url, resultField)
                        .then(() => {
                            this.props.unfreeze();
                            this.query();
                        });
                };

                // The fields to be patched, field should contain id
                patch = fields => {
                    this.checkSetup();
                    this.props.freeze();
                    return this.props.patchEntity(entityName, fields, this.state.url, resultField)
                        .then(() => {
                            this.props.unfreeze();
                            this.query()
                        });
                };

                // Accepts the entity object that contains id or the id itself as a string
                delete = entity => {
                    this.checkSetup();
                    if (typeof entity === 'string') entity = {id: entity};
                    this.props.freeze();
                    return this.props.deleteEntity(entityName, entity, this.state.url, resultField)
                        .then(() => {
                            this.props.unfreeze();
                            this.query();
                        });
                };

                setPreLoader = preLoaderFunc => {this.preLoaderFunc = preLoaderFunc};

                preload = (params, url) => {
                    if (!this.preLoaderFunc) return;

                    // If in smartPreload mode and average of network calls are above 0.3 seconds do not preload
                    if (smartPreload) {
                        const {average, numberOfCalls} = this.props[PL(entityName)].networkTimer;
                        if (numberOfCalls > 3 && average > smartThresholdTime) return;
                    }

                    // The next 3 lines are repetitive and should be optimized
                    const queryData = this.props[PL(entityName)][encodeAPICall(url, params)] || {};
                    const queryMetadata = resultField ? {...queryData} : undefined;
                    if (resultField) delete queryMetadata[resultField];


                    const paramsList = this.preLoaderFunc(params, {...this.state.params, ...params}, {...queryMetadata});

                    paramsList.forEach(params => {
                        const fullParams = {...this.state.params, ...params};
                        const data = this.props[PL(entityName)][encodeAPICall(url, fullParams)];
                        if (data) return;
                        this.props.queryEntities(entityName, url, fullParams, !data, true, smartPreload)
                            .then(() => {this.collectGarbage(url, fullParams);})
                            .catch(() => {});
                    })
                };

                // Garbage collector so the redux storage will not blow up!
                collectGarbage = (url, params) => this.props.pushToQueue(entityName, encodeAPICall(url, params), retain_number);

                render() {
                    const {url, params} = this.state;
                    const queryData = this.props[PL(entityName)][encodeAPICall(url, params)] || {};
                    const queryMetadata = resultField ? {...queryData} : undefined;
                    if (resultField) delete queryMetadata[resultField];
                    const injectedProps = {
                        [PL(entityName) + 'QueryParams']: this.state.params,
                        [PL(entityName)]: (resultField ? (queryData.data && queryData.data[resultField]) : queryData.data) || [],
                        [PL(entityName) + 'Metadata']: queryMetadata,
                        ['initialQuery' + CFL(PL(entityName))]: this.initialQuery,
                        ['query' + CFL(PL(entityName))]: this.query,
                        ['create' + CFL(entityName)]: this.create,
                        ['update' + CFL(entityName)]: this.update,
                        ['patch' + CFL(entityName)]: this.patch,
                        ['delete' + CFL(entityName)]: this.delete,
                        ['set' + CFL(PL(entityName)) + 'Preloader']: this.setPreLoader,
                        ['loading' + CFL(PL(entityName))]: this.state.loadingData,
                    };
                    return (
                        <WrappedComponent
                            {...this.props}
                            {...filteredProps}
                            {...injectedProps}
                        />
                    )
                }
            }
        );