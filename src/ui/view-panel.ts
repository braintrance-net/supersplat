import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import type { PointCloudBoundarySettings } from '../point-cloud-boundary';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import { Tooltips } from './tooltips';

class ViewPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'view-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // header

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            text: '\uE403',
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: localize('panel.view-options'),
            class: 'panel-header-label'
        });

        header.append(icon);
        header.append(label);

        // colors

        const clrRow = new Container({
            class: 'view-panel-row'
        });

        const clrLabel = new Label({
            text: localize('panel.view-options.colors'),
            class: 'view-panel-row-label'
        });

        const clrPickers = new Container({
            class: 'view-panel-row-pickers'
        });

        const bgClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 3,
            value: [0, 0, 0]
        });

        const selectedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 1]
        });

        const unselectedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 1]
        });

        const lockedClrPicker = new ColorPicker({
            class: 'view-panel-row-picker',
            channels: 4,
            value: [0, 0, 0, 1]
        });

        const toArray = (clr: Color) => {
            return [clr.r, clr.g, clr.b, clr.a];
        };

        events.on('bgClr', (clr: Color) => {
            bgClrPicker.value = toArray(clr);
        });

        events.on('selectedClr', (clr: Color) => {
            selectedClrPicker.value = toArray(clr);
        });

        events.on('unselectedClr', (clr: Color) => {
            unselectedClrPicker.value = toArray(clr);
        });

        events.on('lockedClr', (clr: Color) => {
            lockedClrPicker.value = toArray(clr);
        });

        clrPickers.append(bgClrPicker);
        clrPickers.append(selectedClrPicker);
        clrPickers.append(unselectedClrPicker);
        clrPickers.append(lockedClrPicker);

        clrRow.append(clrLabel);
        clrRow.append(clrPickers);

        // tonemapping

        const tonemappingRow = new Container({
            class: 'view-panel-row'
        });

        const tonemappingLabel = new Label({
            text: localize('panel.view-options.tonemapping'),
            class: 'view-panel-row-label'
        });

        const tonemappingSelection = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: 'linear',
            options: [
                { v: 'linear', t: localize('panel.view-options.tonemapping.linear') },
                { v: 'neutral', t: localize('panel.view-options.tonemapping.neutral') },
                { v: 'aces', t: localize('panel.view-options.tonemapping.aces') },
                { v: 'aces2', t: localize('panel.view-options.tonemapping.aces2') },
                { v: 'filmic', t: localize('panel.view-options.tonemapping.filmic') },
                { v: 'hejl', t: localize('panel.view-options.tonemapping.hejl') }
            ]
        });

        tonemappingRow.append(tonemappingLabel);
        tonemappingRow.append(tonemappingSelection);

        // camera fov

        const fovRow = new Container({
            class: 'view-panel-row'
        });

        const fovLabel = new Label({
            text: localize('panel.view-options.fov'),
            class: 'view-panel-row-label'
        });

        const fovSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 10,
            max: 120,
            precision: 1,
            value: 60
        });

        fovRow.append(fovLabel);
        fovRow.append(fovSlider);

        // sh bands
        const shBandsRow = new Container({
            class: 'view-panel-row'
        });

        const shBandsLabel = new Label({
            text: localize('panel.view-options.sh-bands'),
            class: 'view-panel-row-label'
        });

        const shBandsSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0,
            max: 3,
            precision: 0,
            value: 3
        });

        shBandsRow.append(shBandsLabel);
        shBandsRow.append(shBandsSlider);

        // camera fly speed

        const cameraFlySpeedRow = new Container({
            class: 'view-panel-row'
        });

        const cameraFlySpeedLabel = new Label({
            text: localize('panel.view-options.fly-speed'),
            class: 'view-panel-row-label'
        });

        const cameraFlySpeedSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0.1,
            max: 30,
            precision: 1,
            value: 1
        });

        cameraFlySpeedRow.append(cameraFlySpeedLabel);
        cameraFlySpeedRow.append(cameraFlySpeedSlider);

        // centers size

        const centersSizeRow = new Container({
            class: 'view-panel-row'
        });

        const centersSizeLabel = new Label({
            text: localize('panel.view-options.centers-size'),
            class: 'view-panel-row-label'
        });

        const centersSizeSlider = new SliderInput({
            class: 'view-panel-row-slider',
            min: 0,
            max: 10,
            precision: 1,
            value: 2
        });

        centersSizeRow.append(centersSizeLabel);
        centersSizeRow.append(centersSizeSlider);

        // centers gaussian color
        const centersColorRow = new Container({
            class: 'view-panel-row'
        });

        const centersColorLabel = new Label({
            text: localize('panel.view-options.centers-gaussian-color'),
            class: 'view-panel-row-label'
        });

        const centersColorToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        centersColorRow.append(centersColorLabel);
        centersColorRow.append(centersColorToggle);

        // outline selection

        const outlineSelectionRow = new Container({
            class: 'view-panel-row'
        });

        const outlineSelectionLabel = new Label({
            text: localize('panel.view-options.outline-selection'),
            class: 'view-panel-row-label'
        });

        const outlineSelectionToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        outlineSelectionRow.append(outlineSelectionLabel);
        outlineSelectionRow.append(outlineSelectionToggle);

        // selected splats overlay

        const selectedSplatsOverlayRow = new Container({
            class: 'view-panel-row'
        });

        const selectedSplatsOverlayLabel = new Label({
            text: 'Selected Splats',
            class: 'view-panel-row-label'
        });

        const selectedSplatsOverlayToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        selectedSplatsOverlayRow.append(selectedSplatsOverlayLabel);
        selectedSplatsOverlayRow.append(selectedSplatsOverlayToggle);

        // show grid

        const showGridRow = new Container({
            class: 'view-panel-row'
        });

        const showGridLabel = new Label({
            text: localize('panel.view-options.show-grid'),
            class: 'view-panel-row-label'
        });

        const showGridToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: true
        });

        showGridRow.append(showGridLabel);
        showGridRow.append(showGridToggle);

        // show bound

        const showBoundRow = new Container({
            class: 'view-panel-row'
        });

        const showBoundLabel = new Label({
            text: localize('panel.view-options.show-bound'),
            class: 'view-panel-row-label'
        });

        const showBoundToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: true
        });

        showBoundRow.append(showBoundLabel);
        showBoundRow.append(showBoundToggle);

        // voxel mesh

        const voxelMeshRow = new Container({
            class: 'view-panel-row'
        });

        const voxelMeshLabel = new Label({
            text: 'Voxel Mesh',
            class: 'view-panel-row-label'
        });

        const voxelMeshToggle = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });

        voxelMeshRow.append(voxelMeshLabel);
        voxelMeshRow.append(voxelMeshToggle);

        // point-cloud boundary effect
        const pointCloudHeader = new Container({ class: 'view-panel-row' });
        pointCloudHeader.append(new Label({ text: 'Point-cloud boundary', class: 'view-panel-row-label' }));

        const pointCloudEnabled = new BooleanInput({
            type: 'toggle',
            class: 'view-panel-row-toggle',
            value: false
        });
        pointCloudHeader.append(pointCloudEnabled);

        const pointCloudBoundsRow = new Container({ class: 'view-panel-row' });
        pointCloudBoundsRow.append(new Label({ text: 'Bounds', class: 'view-panel-row-label' }));
        const pointCloudBoundsMode = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: 'automatic',
            options: [
                { v: 'automatic', t: 'Automatic splat bounds' },
                { v: 'manual', t: 'Manual box' }
            ]
        });
        pointCloudBoundsRow.append(pointCloudBoundsMode);

        const pointCloudPreviewRow = new Container({ class: 'view-panel-row' });
        pointCloudPreviewRow.append(new Label({ text: 'Preview', class: 'view-panel-row-label' }));
        const pointCloudPreview = new SelectInput({
            class: 'view-panel-row-select',
            defaultValue: 'automatic',
            options: [
                { v: 'automatic', t: 'Automatic' },
                { v: 'inside', t: 'Inside' },
                { v: 'boundary', t: 'Boundary' },
                { v: 'outside', t: 'Outside' }
            ]
        });
        pointCloudPreviewRow.append(pointCloudPreview);

        const createPointCloudSlider = (labelText: string, min: number, max: number, precision: number, value: number) => {
            const row = new Container({ class: 'view-panel-row' });
            row.append(new Label({ text: labelText, class: 'view-panel-row-label' }));
            const input = new SliderInput({
                class: 'view-panel-row-slider',
                min,
                max,
                precision,
                value
            });
            row.append(input);
            return { row, input };
        };
        const pointCloudFade = createPointCloudSlider('Fade width', 0.01, 20, 2, 1);
        const pointCloudRadius = createPointCloudSlider('Point radius', 0.5, 8, 1, 2);
        const pointCloudOpacity = createPointCloudSlider('Point opacity', 0, 1, 2, 1);

        const pointCloudManualRow = new Container({ class: 'view-panel-row' });
        pointCloudManualRow.append(new Label({ text: 'Manual volume', class: 'view-panel-row-label' }));
        const editBoundary = new Button({ text: 'Edit boundary', class: 'view-panel-row-select' });
        pointCloudManualRow.append(editBoundary);

        const pointCloudStatusRow = new Container({ class: 'view-panel-row' });
        const pointCloudStatus = new Label({ text: 'Disabled', class: 'view-panel-row-label' });
        pointCloudStatusRow.append(pointCloudStatus);

        this.append(header);
        this.append(clrRow);
        this.append(tonemappingRow);
        this.append(fovRow);
        this.append(shBandsRow);
        this.append(cameraFlySpeedRow);
        this.append(centersSizeRow);
        this.append(centersColorRow);
        this.append(outlineSelectionRow);
        this.append(selectedSplatsOverlayRow);
        this.append(showGridRow);
        this.append(showBoundRow);
        this.append(voxelMeshRow);
        this.append(pointCloudHeader);
        this.append(pointCloudBoundsRow);
        this.append(pointCloudPreviewRow);
        this.append(pointCloudFade.row);
        this.append(pointCloudRadius.row);
        this.append(pointCloudOpacity.row);
        this.append(pointCloudManualRow);
        this.append(pointCloudStatusRow);

        // handle panel visibility

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('viewPanel.visible', visible);
                if (visible) {
                    voxelMeshToggle.value = Boolean(events.invoke('walk.collisionMeshVisualize'));
                }
            }
        };

        events.function('viewPanel.visible', () => {
            return !this.hidden;
        });

        events.on('viewPanel.setVisible', (visible: boolean) => {
            setVisible(visible);
        });

        events.on('viewPanel.toggleVisible', () => {
            setVisible(this.hidden);
        });

        events.on('pointCloudBoundary.togglePanel', () => {
            if (!this.hidden) {
                setVisible(false);
                return;
            }

            setVisible(true);
            window.requestAnimationFrame(() => {
                pointCloudHeader.dom.scrollIntoView({ block: 'center' });
                pointCloudHeader.dom.classList.add('point-cloud-boundary-focus');
                window.setTimeout(() => {
                    pointCloudHeader.dom.classList.remove('point-cloud-boundary-focus');
                }, 1200);
            });
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });

        // sh bands

        events.on('view.bands', (bands: number) => {
            shBandsSlider.value = bands;
        });

        shBandsSlider.on('change', (value: number) => {
            events.fire('view.setBands', value);
        });

        // splat size

        events.on('camera.splatSize', (value: number) => {
            centersSizeSlider.value = value;
        });

        centersSizeSlider.on('change', (value: number) => {
            events.fire('camera.setSplatSize', value);
            events.fire('camera.setOverlay', true);
            events.fire('camera.setMode', 'centers');
        });

        // centers gaussian color
        events.on('view.centersUseGaussianColor', (value: boolean) => {
            centersColorToggle.value = value;
        });

        centersColorToggle.on('change', (value: boolean) => {
            events.fire('view.setCentersUseGaussianColor', value);
        });

        // camera speed

        events.on('camera.flySpeed', (value: number) => {
            cameraFlySpeedSlider.value = value;
        });

        cameraFlySpeedSlider.on('change', (value: number) => {
            events.fire('camera.setFlySpeed', value);
        });

        // outline selection

        events.on('view.outlineSelection', (value: boolean) => {
            outlineSelectionToggle.value = value;
        });

        outlineSelectionToggle.on('change', (value: boolean) => {
            events.fire('view.setOutlineSelection', value);
        });

        // selected splats overlay

        events.on('view.selectedSplatsOverlay', (value: boolean) => {
            selectedSplatsOverlayToggle.value = value;
        });

        selectedSplatsOverlayToggle.on('change', (value: boolean) => {
            events.fire('view.setSelectedSplatsOverlay', value);
        });

        // show grid

        events.on('grid.visible', (visible: boolean) => {
            showGridToggle.value = visible;
        });

        showGridToggle.on('change', () => {
            events.fire('grid.setVisible', showGridToggle.value);
        });

        // show bound

        events.on('camera.bound', (visible: boolean) => {
            showBoundToggle.value = visible;
        });

        showBoundToggle.on('change', () => {
            events.fire('camera.setBound', showBoundToggle.value);
        });

        // voxel mesh

        events.on('walk.collisionMeshVisualize', (visible: boolean) => {
            voxelMeshToggle.value = Boolean(visible);
        });

        voxelMeshToggle.on('change', () => {
            events.fire('walk.collisionMeshVisualize', voxelMeshToggle.value);
        });

        const patchPointCloud = (patch: Partial<PointCloudBoundarySettings>) => {
            events.fire('pointCloudBoundary.patch', patch);
        };
        pointCloudEnabled.on('change', (value: boolean) => patchPointCloud({ enabled: value }));
        pointCloudBoundsMode.on('change', (value: PointCloudBoundarySettings['boundsMode']) => {
            patchPointCloud({ boundsMode: value });
        });
        pointCloudPreview.on('change', (value: PointCloudBoundarySettings['preview']) => {
            patchPointCloud({ preview: value });
        });
        pointCloudFade.input.on('change', (value: number) => patchPointCloud({ fadeWidth: value }));
        pointCloudRadius.input.on('change', (value: number) => patchPointCloud({ pointRadius: value }));
        pointCloudOpacity.input.on('change', (value: number) => patchPointCloud({ pointOpacity: value }));
        editBoundary.on('click', () => {
            const settings = events.invoke('pointCloudBoundary.settings') as PointCloudBoundarySettings;
            if (events.invoke('tool.active') !== 'boxVolume') events.fire('tool.boxVolume');
            events.fire('boxVolume.beginBoundaryAuthoring', settings.manualBounds);
        });

        events.on('pointCloudBoundary.settings', (settings: PointCloudBoundarySettings) => {
            pointCloudEnabled.value = settings.enabled;
            pointCloudBoundsMode.value = settings.boundsMode;
            pointCloudPreview.value = settings.preview;
            pointCloudFade.input.value = settings.fadeWidth;
            pointCloudRadius.input.value = settings.pointRadius;
            pointCloudOpacity.input.value = settings.pointOpacity;
        });
        events.on('pointCloudBoundary.state', (state: {
            enabled: boolean;
            hasBounds: boolean;
            boundsMode: string;
            signedDistance: number | null;
            weight: number;
        }) => {
            if (!state.enabled) {
                pointCloudStatus.text = 'Disabled';
            } else if (!state.hasBounds) {
                pointCloudStatus.text = `No ${state.boundsMode} bounds`;
            } else {
                pointCloudStatus.text = `Distance ${state.signedDistance.toFixed(2)} · morph ${(state.weight * 100).toFixed(0)}%`;
            }
        });

        // background color

        bgClrPicker.on('change', (value: number[]) => {
            events.fire('setBgClr', new Color(value[0], value[1], value[2]));
        });

        selectedClrPicker.on('change', (value: number[]) => {
            events.fire('setSelectedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        unselectedClrPicker.on('change', (value: number[]) => {
            events.fire('setUnselectedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        lockedClrPicker.on('change', (value: number[]) => {
            events.fire('setLockedClr', new Color(value[0], value[1], value[2], value[3]));
        });

        // camera fov

        events.on('camera.fov', (fov: number) => {
            fovSlider.value = fov;
        });

        fovSlider.on('change', (value: number) => {
            events.fire('camera.setFov', value);
        });

        // tonemapping

        events.on('camera.tonemapping', (tonemapping: string) => {
            tonemappingSelection.value = tonemapping;
        });

        tonemappingSelection.on('change', (value: string) => {
            events.fire('camera.setTonemapping', value);
        });

        // tooltips
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const shortcut = shortcutManager.formatShortcut('grid.toggleVisible');
        tooltips.register(showGridLabel, `${localize('panel.view-options.show-grid')} ( ${shortcut} )`, 'left');
        tooltips.register(bgClrPicker, localize('panel.view-options.background-color'), 'left');
        tooltips.register(selectedClrPicker, localize('panel.view-options.selected-color'), 'top');
        tooltips.register(unselectedClrPicker, localize('panel.view-options.unselected-color'), 'top');
        tooltips.register(lockedClrPicker, localize('panel.view-options.locked-color'), 'top');
        tooltips.register(selectedSplatsOverlayLabel, 'Tint selected splats with their real Gaussian footprint', 'left');
        tooltips.register(pointCloudHeader, 'Morph Gaussians to fixed-size centers outside the transition volume.', 'left');
        tooltips.register(editBoundary, 'Place or edit the oriented transition volume without changing the selection.', 'left');
    }
}

export { ViewPanel };
