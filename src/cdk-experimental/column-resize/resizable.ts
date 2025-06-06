/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  AfterViewInit,
  Directive,
  ElementRef,
  inject,
  Injector,
  NgZone,
  OnDestroy,
  OnInit,
  Type,
  ViewContainerRef,
  ChangeDetectorRef,
  afterNextRender,
  runInInjectionContext,
} from '@angular/core';
import {Directionality} from '@angular/cdk/bidi';
import {ComponentPortal} from '@angular/cdk/portal';
import {
  createFlexibleConnectedPositionStrategy,
  createOverlayRef,
  createRepositionScrollStrategy,
  OverlayRef,
} from '@angular/cdk/overlay';
import {CdkColumnDef} from '@angular/cdk/table';
import {merge, Subject} from 'rxjs';
import {distinctUntilChanged, filter, take, takeUntil} from 'rxjs/operators';

import {_closest} from '../popover-edit';

import {HEADER_ROW_SELECTOR} from './selectors';
import {ResizeOverlayHandle} from './overlay-handle';
import {ColumnResize} from './column-resize';
import {ColumnSizeAction, ColumnResizeNotifierSource} from './column-resize-notifier';
import {ColumnSizeStore} from './column-size-store';
import {HeaderRowEventDispatcher} from './event-dispatcher';
import {ResizeRef} from './resize-ref';
import {ResizeStrategy} from './resize-strategy';
import {_CoalescedStyleScheduler} from './coalesced-style-scheduler';

const OVERLAY_ACTIVE_CLASS = 'cdk-resizable-overlay-thumb-active';
const RESIZE_DISABLED_CLASS = 'cdk-resizable-resize-disabled';

/**
 * Base class for Resizable directives which are applied to column headers to make those columns
 * resizable.
 */
@Directive()
export abstract class Resizable<HandleComponent extends ResizeOverlayHandle>
  implements AfterViewInit, OnDestroy, OnInit
{
  protected minWidthPxInternal: number = 0;
  protected maxWidthPxInternal: number = Number.MAX_SAFE_INTEGER;

  protected inlineHandle?: HTMLElement;
  protected overlayRef?: OverlayRef;
  protected readonly destroyed = new Subject<void>();

  protected abstract readonly columnDef: CdkColumnDef;
  protected abstract readonly columnResize: ColumnResize;
  protected abstract readonly directionality: Directionality;
  protected abstract readonly document: Document;
  protected abstract readonly elementRef: ElementRef;
  protected abstract readonly eventDispatcher: HeaderRowEventDispatcher;
  protected abstract readonly injector: Injector;
  protected abstract readonly ngZone: NgZone;
  protected abstract readonly resizeNotifier: ColumnResizeNotifierSource;
  protected abstract readonly resizeStrategy: ResizeStrategy;
  protected abstract readonly styleScheduler: _CoalescedStyleScheduler;
  protected abstract readonly viewContainerRef: ViewContainerRef;
  protected abstract readonly changeDetectorRef: ChangeDetectorRef;

  protected readonly columnSizeStore = inject(ColumnSizeStore, {optional: true});
  private _injector = inject(Injector);

  private _viewInitialized = false;
  private _isDestroyed = false;

  /** The minimum width to allow the column to be sized to. */
  get minWidthPx(): number {
    return this.minWidthPxInternal;
  }
  set minWidthPx(value: number) {
    this.minWidthPxInternal = value;

    this.columnResize.setResized();
    if (this.elementRef.nativeElement && this._viewInitialized) {
      this._applyMinWidthPx();
    }
  }

  /** The maximum width to allow the column to be sized to. */
  get maxWidthPx(): number {
    return this.maxWidthPxInternal;
  }
  set maxWidthPx(value: number) {
    this.maxWidthPxInternal = value;

    this.columnResize.setResized();
    if (this.elementRef.nativeElement && this._viewInitialized) {
      this._applyMaxWidthPx();
    }
  }

  ngOnInit() {
    this.resizeStrategy.registerColumn(this.elementRef.nativeElement);
  }

  ngAfterViewInit() {
    this._listenForRowHoverEvents();
    this._listenForResizeEvents();
    this._appendInlineHandle();

    this.styleScheduler.scheduleEnd(() => {
      if (this._isDestroyed) return;
      this._viewInitialized = true;
      this._applyMinWidthPx();
      this._applyMaxWidthPx();
      this.columnSizeStore
        ?.getSize(this.columnResize.getTableId(), this.columnDef.name)
        ?.pipe(take(1), takeUntil(this.destroyed))
        .subscribe(size => {
          if (size == null) {
            return;
          }
          this._applySize(size);
        });
    });
  }

  ngOnDestroy(): void {
    this._isDestroyed = true;
    this.destroyed.next();
    this.destroyed.complete();
    this.inlineHandle?.remove();
    this.overlayRef?.dispose();
  }

  protected abstract getInlineHandleCssClassName(): string;

  protected abstract getOverlayHandleComponentType(): Type<HandleComponent>;

  private _createOverlayForHandle(): OverlayRef {
    // Use of overlays allows us to properly capture click events spanning parts
    // of two table cells and is also useful for displaying a resize thumb
    // over both cells and extending it down the table as needed.

    const isRtl = this.directionality.value === 'rtl';
    const positionStrategy = createFlexibleConnectedPositionStrategy(
      this._injector,
      this.elementRef.nativeElement!,
    )
      .withFlexibleDimensions(false)
      .withGrowAfterOpen(false)
      .withPush(false)
      .withDefaultOffsetX(isRtl ? 1 : 0)
      .withPositions([
        {
          originX: isRtl ? 'start' : 'end',
          originY: 'top',
          overlayX: 'center',
          overlayY: 'top',
        },
      ]);

    return createOverlayRef(this._injector, {
      // Always position the overlay based on left-indexed coordinates.
      direction: 'ltr',
      disposeOnNavigation: true,
      positionStrategy,
      scrollStrategy: createRepositionScrollStrategy(this._injector),
      width: '16px',
    });
  }

  private _listenForRowHoverEvents(): void {
    const element = this.elementRef.nativeElement!;
    const takeUntilDestroyed = takeUntil<boolean>(this.destroyed);

    this.eventDispatcher
      .resizeOverlayVisibleForHeaderRow(_closest(element, HEADER_ROW_SELECTOR)!)
      .pipe(takeUntilDestroyed)
      .subscribe(hoveringRow => {
        if (hoveringRow) {
          const tooBigToResize =
            this.maxWidthPxInternal < Number.MAX_SAFE_INTEGER &&
            element.offsetWidth > this.maxWidthPxInternal;
          element.classList.toggle(RESIZE_DISABLED_CLASS, tooBigToResize);

          if (!tooBigToResize) {
            if (!this.overlayRef) {
              this.overlayRef = this._createOverlayForHandle();
            }

            this._showHandleOverlay();
          }
        } else if (this.overlayRef) {
          // todo - can't detach during an active resize - need to work that out
          this.overlayRef.detach();
        }
      });
  }

  private _listenForResizeEvents() {
    const takeUntilDestroyed = takeUntil<ColumnSizeAction>(this.destroyed);

    merge(this.resizeNotifier.resizeCanceled, this.resizeNotifier.triggerResize)
      .pipe(
        takeUntilDestroyed,
        filter(columnSize => columnSize.columnId === this.columnDef.name),
      )
      .subscribe(({size, previousSize, completeImmediately}) => {
        this.elementRef.nativeElement!.classList.add(OVERLAY_ACTIVE_CLASS);
        this._applySize(size, previousSize);

        if (completeImmediately) {
          this._completeResizeOperation();
        }
      });

    merge(this.resizeNotifier.resizeCanceled, this.resizeNotifier.resizeCompleted)
      .pipe(takeUntilDestroyed)
      .subscribe(columnSize => {
        this._cleanUpAfterResize(columnSize);
      });

    this.resizeNotifier.resizeCompleted
      .pipe(
        filter(sizeUpdate => sizeUpdate.columnId === this.columnDef.name),
        distinctUntilChanged((a, b) => a.size === b.size),
        takeUntil(this.destroyed),
      )
      .subscribe(sizeUpdate => {
        this.columnSizeStore?.setSize(
          this.columnResize.getTableId(),
          this.columnDef.name,
          sizeUpdate.size,
        );
      });
  }

  private _completeResizeOperation(): void {
    this.ngZone.run(() => {
      this.resizeNotifier.resizeCompleted.next({
        columnId: this.columnDef.name,
        size: this.elementRef.nativeElement!.offsetWidth,
      });
    });
  }

  private _cleanUpAfterResize(columnSize: ColumnSizeAction): void {
    this.elementRef.nativeElement!.classList.remove(OVERLAY_ACTIVE_CLASS);

    if (this.overlayRef && this.overlayRef.hasAttached()) {
      this._updateOverlayHandleHeight();
      this.overlayRef.updatePosition();

      if (columnSize.columnId === this.columnDef.name) {
        this.inlineHandle!.focus();
      }
    }
  }

  private _createHandlePortal(): ComponentPortal<HandleComponent> {
    const injector = Injector.create({
      parent: this.injector,
      providers: [
        {
          provide: ResizeRef,
          useValue: new ResizeRef(
            this.elementRef,
            this.overlayRef!,
            this.minWidthPx,
            this.maxWidthPx,
            this.columnResize.liveResizeUpdates,
          ),
        },
      ],
    });

    return new ComponentPortal(
      this.getOverlayHandleComponentType(),
      this.viewContainerRef,
      injector,
    );
  }

  private _showHandleOverlay(): void {
    this._updateOverlayHandleHeight();
    this.overlayRef!.attach(this._createHandlePortal());

    // Needed to ensure that all of the lifecycle hooks inside the overlay run immediately.
    this.changeDetectorRef.markForCheck();
  }

  private _updateOverlayHandleHeight() {
    runInInjectionContext(this.injector, () => {
      afterNextRender({
        write: () => {
          this.overlayRef!.updateSize({height: this.elementRef.nativeElement!.offsetHeight});
        },
      });
    });
  }

  private _applySize(sizeInPixels: number, previousSize?: number): void {
    const sizeToApply = Math.min(Math.max(sizeInPixels, this.minWidthPx, 0), this.maxWidthPx);

    this.resizeStrategy.applyColumnSize(
      this.columnDef.cssClassFriendlyName,
      this.elementRef.nativeElement!,
      sizeToApply,
      previousSize,
    );
  }

  private _applyMinWidthPx(): void {
    this.resizeStrategy.applyMinColumnSize(
      this.columnDef.cssClassFriendlyName,
      this.elementRef.nativeElement,
      this.minWidthPx,
    );
  }

  private _applyMaxWidthPx(): void {
    this.resizeStrategy.applyMaxColumnSize(
      this.columnDef.cssClassFriendlyName,
      this.elementRef.nativeElement,
      this.maxWidthPx,
    );
  }

  private _appendInlineHandle(): void {
    this.inlineHandle = this.document.createElement('div');
    // TODO: re-apply tab index once this element has behavior.
    // this.inlineHandle.tabIndex = 0;
    this.inlineHandle.className = this.getInlineHandleCssClassName();

    // TODO: Apply correct aria role (probably slider) after a11y spec questions resolved.

    this.elementRef.nativeElement!.appendChild(this.inlineHandle);
  }
}
