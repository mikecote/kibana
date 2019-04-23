/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { EuiFlexGroup, EuiFlexItem, EuiButton } from '@elastic/eui';
import { injectI18n } from '@kbn/i18n/react';
import React from 'react';
import { kfetch } from 'ui/kfetch';

import { AutocompleteField } from '../../../components/autocomplete_field';
import { Toolbar } from '../../../components/eui/toolbar';
import { SourceConfigurationButton } from '../../../components/source_configuration';
import { WaffleGroupByControls } from '../../../components/waffle/waffle_group_by_controls';
import { WaffleMetricControls } from '../../../components/waffle/waffle_metric_controls';
import { WaffleNodeTypeSwitcher } from '../../../components/waffle/waffle_node_type_switcher';
import { WaffleTimeControls } from '../../../components/waffle/waffle_time_controls';
import { WithWaffleFilter } from '../../../containers/waffle/with_waffle_filters';
import { WithWaffleOptions } from '../../../containers/waffle/with_waffle_options';
import { WithWaffleTime } from '../../../containers/waffle/with_waffle_time';
import { WithKueryAutocompletion } from '../../../containers/with_kuery_autocompletion';
import { WithSource } from '../../../containers/with_source';
import { ScheduledAlertBuilder } from '../../../../../alerts_poc/public/scheduled_alert_builder';

interface State {
  showModal: boolean;
  alert?: string;
  interval: string;
  throttle?: string;
  warningThreshold: number;
  warningActionsMap: {
    [id: string]: boolean;
  };
  warningActions: Array<{
    id: string;
    realId: string;
    label: string;
  }>;
  severeThreshold: number;
  severeActionsMap: {
    [id: string]: boolean;
  };
  severeActions: Array<{
    id: string;
    realId: string;
    label: string;
  }>;
}

let counter = 0;
function makeId() {
  return (++counter).toString();
}

class Component extends React.Component<any, State> {
  constructor(props: any) {
    super(props);

    const warningIdPrefix = makeId();
    const severeIdPrefix = makeId();

    this.state = {
      showModal: false,
      alert: 'cpu-check',
      interval: '10000',
      throttle: undefined,
      warningThreshold: 50,
      warningActionsMap: {},
      warningActions: [
        {
          id: `${warningIdPrefix}:console-log`,
          realId: 'console-log',
          label: 'Send message to the console',
        },
        {
          id: `${warningIdPrefix}:turn-on-alarm-light`,
          realId: 'turn-on-alarm-light',
          label: 'Turn on a physical alarm light',
        },
      ],
      severeThreshold: 80,
      severeActionsMap: {},
      severeActions: [
        {
          id: `${severeIdPrefix}:console-log`,
          realId: 'console-log',
          label: 'Send message to the console',
        },
        {
          id: `${severeIdPrefix}:turn-on-alarm-light`,
          realId: 'turn-on-alarm-light',
          label: 'Turn on a physical alarm light',
        },
      ],
    };
  }
  async onSaveClick() {
    const response = await kfetch({
      method: 'POST',
      pathname: '/api/schedule-action',
      body: JSON.stringify({
        id: this.state.alert,
        interval: Number(this.state.interval),
        throttle: this.state.throttle ? Number(this.state.throttle) : undefined,
        actionGroupsPriority: ['severe', 'warning', 'default'],
        actionGroups: {
          default: [],
          warning: this.state.warningActions
            .filter(({ id }) => this.state.warningActionsMap[id])
            .map(action => ({ id: action.realId, params: {} })),
          severe: this.state.severeActions
            .filter(({ id }) => this.state.severeActionsMap[id])
            .map(action => ({ id: action.realId, params: {} })),
        },
        checkParams: {
          warningThreshold: this.state.warningThreshold,
          severeThreshold: this.state.severeThreshold,
        },
      }),
    });
    if (response.success === true) {
      this.setState({ showModal: false });
    }
  }
  render() {
    const { intl } = this.props;
    return (
      <Toolbar>
        <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" gutterSize="m">
          <EuiFlexItem>
            <WithSource>
              {({ derivedIndexPattern }) => (
                <WithKueryAutocompletion indexPattern={derivedIndexPattern}>
                  {({ isLoadingSuggestions, loadSuggestions, suggestions }) => (
                    <WithWaffleFilter indexPattern={derivedIndexPattern}>
                      {({
                        applyFilterQueryFromKueryExpression,
                        filterQueryDraft,
                        isFilterQueryDraftValid,
                        setFilterQueryDraftFromKueryExpression,
                      }) => (
                        <AutocompleteField
                          isLoadingSuggestions={isLoadingSuggestions}
                          isValid={isFilterQueryDraftValid}
                          loadSuggestions={loadSuggestions}
                          onChange={setFilterQueryDraftFromKueryExpression}
                          onSubmit={applyFilterQueryFromKueryExpression}
                          placeholder={intl.formatMessage({
                            id: 'xpack.infra.homePage.toolbar.kqlSearchFieldPlaceholder',
                            defaultMessage:
                              'Search for infrastructure data… (e.g. host.name:host-1)',
                          })}
                          suggestions={suggestions}
                          value={filterQueryDraft ? filterQueryDraft.expression : ''}
                        />
                      )}
                    </WithWaffleFilter>
                  )}
                </WithKueryAutocompletion>
              )}
            </WithSource>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <WithWaffleTime resetOnUnmount>
              {({ currentTime, isAutoReloading, jumpToTime, startAutoReload, stopAutoReload }) => (
                <WaffleTimeControls
                  currentTime={currentTime}
                  isLiveStreaming={isAutoReloading}
                  onChangeTime={jumpToTime}
                  startLiveStreaming={startAutoReload}
                  stopLiveStreaming={stopAutoReload}
                />
              )}
            </WithWaffleTime>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiFlexGroup alignItems="center" gutterSize="m">
          <WithSource>
            {({ derivedIndexPattern }) => (
              <WithWaffleOptions>
                {({
                  changeMetric,
                  changeNodeType,
                  changeGroupBy,
                  changeCustomOptions,
                  customOptions,
                  groupBy,
                  metric,
                  nodeType,
                }) => (
                  <React.Fragment>
                    <EuiFlexItem grow={false}>
                      <WaffleNodeTypeSwitcher
                        nodeType={nodeType}
                        changeNodeType={changeNodeType}
                        changeMetric={changeMetric}
                        changeGroupBy={changeGroupBy}
                      />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <WaffleMetricControls
                        metric={metric}
                        nodeType={nodeType}
                        onChange={changeMetric}
                      />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <WaffleGroupByControls
                        groupBy={groupBy}
                        nodeType={nodeType}
                        onChange={changeGroupBy}
                        fields={derivedIndexPattern.fields}
                        onChangeCustomOptions={changeCustomOptions}
                        customOptions={customOptions}
                      />
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiButton onClick={() => this.setState({ showModal: true })}>
                        Create Alert
                      </EuiButton>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <SourceConfigurationButton />
                    </EuiFlexItem>
                  </React.Fragment>
                )}
              </WithWaffleOptions>
            )}
          </WithSource>
          {this.state.showModal && (
            <ScheduledAlertBuilder onClose={() => this.setState({ showModal: false })} />
          )}
        </EuiFlexGroup>
      </Toolbar>
    );
  }
}

export const SnapshotToolbar = injectI18n(Component);
