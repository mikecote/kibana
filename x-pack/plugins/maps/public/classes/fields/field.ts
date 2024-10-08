/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { FIELD_ORIGIN } from '../../../common/constants';
import { IVectorSource } from '../sources/vector_source';
import { ITooltipProperty, TooltipProperty } from '../tooltips/tooltip_property';

export interface IField {
  getName(): string;
  getMbFieldName(): string;
  getRootName(): string;
  canValueBeFormatted(): boolean;
  getLabel(): Promise<string>;
  getDataType(): Promise<string>;
  createTooltipProperty(value: string | string[] | undefined): Promise<ITooltipProperty>;
  getSource(): IVectorSource;
  getOrigin(): FIELD_ORIGIN;
  isValid(): boolean;
  getExtendedStatsFieldMetaRequest(): Promise<unknown | null>;
  getPercentilesFieldMetaRequest(percentiles: number[]): Promise<unknown | null>;
  getCategoricalFieldMetaRequest(size: number): Promise<unknown>;

  // Whether Maps-app can automatically determine the domain of the field-values
  // if this is not the case (e.g. for .mvt tiled data),
  // then styling properties that require the domain to be known cannot use this property.
  supportsAutoDomain(): boolean;

  // Whether Maps-app can automatically determine the domain of the field-values
  // _without_ having to retrieve the data as GeoJson
  // e.g. for ES-sources, this would use the extended_stats API
  supportsFieldMeta(): boolean;

  canReadFromGeoJson(): boolean;
  isEqual(field: IField): boolean;
}

export class AbstractField implements IField {
  private readonly _fieldName: string;
  private readonly _origin: FIELD_ORIGIN;

  constructor({ fieldName, origin }: { fieldName: string; origin: FIELD_ORIGIN }) {
    this._fieldName = fieldName;
    this._origin = origin || FIELD_ORIGIN.SOURCE;
  }

  getName(): string {
    return this._fieldName;
  }

  getMbFieldName(): string {
    return this.getName();
  }

  getRootName(): string {
    return this.getName();
  }

  canValueBeFormatted(): boolean {
    return false;
  }

  getSource(): IVectorSource {
    throw new Error('must implement Field#getSource');
  }

  isValid(): boolean {
    return !!this._fieldName;
  }

  async getDataType(): Promise<string> {
    return 'string';
  }

  async getLabel(): Promise<string> {
    return this._fieldName;
  }

  async createTooltipProperty(value: string | string[] | undefined): Promise<ITooltipProperty> {
    const label = await this.getLabel();
    return new TooltipProperty(this.getName(), label, value);
  }

  getOrigin(): FIELD_ORIGIN {
    return this._origin;
  }

  supportsFieldMeta(): boolean {
    return false;
  }

  async getExtendedStatsFieldMetaRequest(): Promise<unknown> {
    return null;
  }

  async getPercentilesFieldMetaRequest(percentiles: number[]): Promise<unknown | null> {
    return null;
  }

  async getCategoricalFieldMetaRequest(size: number): Promise<unknown> {
    return null;
  }

  supportsAutoDomain(): boolean {
    return true;
  }

  canReadFromGeoJson(): boolean {
    return true;
  }

  isEqual(field: IField) {
    return this._origin === field.getOrigin() && this._fieldName === field.getName();
  }
}
