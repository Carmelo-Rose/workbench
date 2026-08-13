#target photoshop

/*
 * Photoshop-only calibration helper. The request JSON path is supplied through
 * WORKBENCH_SHADOW_CALIBRATION_REQUEST. Production never invokes this file.
 *
 * Required request fields: input, outputDir, presetVersion, angleSlot (1..6),
 * angleLabel, roi{x,y,width,height}, sampledPoint{x,y}, sampledRgb[r,g,b], and
 * layerNames{product,shadow,background}. The script works on a duplicate and
 * never saves over the source.
 */
(function () {
    app.displayDialogs = DialogModes.NO;

    function fail(message) { throw new Error("calibrated-shadow: " + message); }
    function parseJson(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        // The request is a local file created by Workbench. Parentheses force
        // object-literal parsing on Photoshop versions without the JSON global.
        try { return eval("(" + text + ")"); }
        catch (error) { fail("request JSON is invalid: " + error.message); }
    }
    function quoteJson(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
    }
    function stringifyJson(value, depth) {
        if (typeof JSON !== "undefined" && JSON.stringify) return JSON.stringify(value, null, 2);
        var indent = "", childIndent = "", index, keys, parts;
        for (index = 0; index < depth; index++) indent += "  ";
        childIndent = indent + "  ";
        if (value === null) return "null";
        if (typeof value === "string") return quoteJson(value);
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        parts = [];
        if (value instanceof Array) {
            for (index = 0; index < value.length; index++) parts.push(childIndent + stringifyJson(value[index], depth + 1));
            return parts.length ? "[\n" + parts.join(",\n") + "\n" + indent + "]" : "[]";
        }
        keys = [];
        for (var key in value) if (value.hasOwnProperty(key)) keys.push(key);
        keys.sort();
        for (index = 0; index < keys.length; index++) parts.push(childIndent + quoteJson(keys[index]) + ": " + stringifyJson(value[keys[index]], depth + 1));
        return parts.length ? "{\n" + parts.join(",\n") + "\n" + indent + "}" : "{}";
    }
    function readJson(file) {
        file.encoding = "UTF8";
        if (!file.open("r")) fail("cannot open request JSON");
        var text = file.read(); file.close();
        return parseJson(text);
    }
    function writeJson(file, value) {
        file.encoding = "UTF8";
        if (!file.open("w")) fail("cannot write report JSON");
        file.write(stringifyJson(value, 0)); file.write("\n"); file.close();
    }
    function addLevelsChannel(list, channel, whitePoint) {
        var adjustment = new ActionDescriptor();
        var reference = new ActionReference();
        reference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), channel);
        adjustment.putReference(charIDToTypeID("Chnl"), reference);
        var input = new ActionList(); input.putInteger(0); input.putInteger(whitePoint);
        adjustment.putList(charIDToTypeID("Inpt"), input);
        adjustment.putDouble(charIDToTypeID("Gmm "), 1.0);
        var output = new ActionList(); output.putInteger(0); output.putInteger(255);
        adjustment.putList(charIDToTypeID("Otpt"), output);
        list.putObject(charIDToTypeID("LvlA"), adjustment);
    }
    function applyLevels(red, green, blue) {
        var descriptor = new ActionDescriptor();
        var adjustments = new ActionList();
        addLevelsChannel(adjustments, charIDToTypeID("Rd  "), red);
        addLevelsChannel(adjustments, charIDToTypeID("Grn "), green);
        addLevelsChannel(adjustments, charIDToTypeID("Bl  "), blue);
        descriptor.putList(charIDToTypeID("Adjs"), adjustments);
        executeAction(charIDToTypeID("Lvls"), descriptor, DialogModes.NO);
    }
    function selectSubject() {
        var descriptor = new ActionDescriptor();
        descriptor.putBoolean(stringIDToTypeID("sampleAllLayers"), false);
        executeAction(stringIDToTypeID("autoCutout"), descriptor, DialogModes.NO);
    }
    function selectFromPinnedMask(document, maskPath) {
        var maskFile = new File(maskPath);
        if (!maskFile.exists) fail("birefnetMask does not exist");
        var maskDocument = app.open(maskFile);
        if (maskDocument.width.as("px") !== document.width.as("px") || maskDocument.height.as("px") !== document.height.as("px")) {
            maskDocument.close(SaveOptions.DONOTSAVECHANGES);
            fail("birefnetMask dimensions do not match input");
        }
        maskDocument.selection.selectAll();
        maskDocument.selection.copy(false);
        maskDocument.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = document;
        var alpha = document.channels.add(); alpha.name = "pinned-birefnet-selection";
        document.activeChannels = [alpha];
        document.paste();
        document.selection.load(alpha);
        alpha.remove();
        document.activeChannels = [document.channels.getByName("Red"), document.channels.getByName("Green"), document.channels.getByName("Blue")];
    }
    function savePng(document, file) {
        var options = new PNGSaveOptions(); options.interlaced = false;
        document.saveAs(file, options, true, Extension.LOWERCASE);
    }
    function duplicateFileLayerInto(filePath, target, layerName, placementLayer) {
        var file = new File(filePath);
        if (!file.exists) fail(layerName + " file does not exist");
        var layerDocument = app.open(file);
        var duplicated = layerDocument.activeLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);
        layerDocument.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = target;
        duplicated.name = layerName;
        if (placementLayer) duplicated.move(placementLayer, ElementPlacement.PLACEBEFORE);
        return duplicated;
    }
    function requireString(value, label) {
        if (typeof value !== "string" || !value.length) fail(label + " is required");
    }
    function requireInteger(value, label) {
        if (typeof value !== "number" || value !== Math.floor(value)) fail(label + " must be an integer");
    }
    function isAdaptiveRequest(value) {
        return value.presetVersion === "hat-ps-shadow-v2.4" || value.presetVersion === "slot-4-development";
    }
    function validateRequest(value) {
        if (!value || typeof value !== "object") fail("request must be an object");
        requireString(value.input, "input"); requireString(value.outputDir, "outputDir");
        requireString(value.presetVersion, "presetVersion"); requireString(value.angleLabel, "angleLabel");
        requireInteger(value.angleSlot, "angleSlot");
        if (value.angleSlot < 1 || value.angleSlot > 6) fail("angleSlot must be from 1 through 6");
        if (!value.roi) fail("roi is required");
        var roiKeys = ["x", "y", "width", "height"];
        for (var index = 0; index < roiKeys.length; index++) requireInteger(value.roi[roiKeys[index]], "roi." + roiKeys[index]);
        if (value.roi.x < 0 || value.roi.y < 0 || value.roi.width <= 0 || value.roi.height <= 0 || value.roi.x >= 800 || value.roi.y >= 800 || value.roi.x + value.roi.width > 800 || value.roi.y + value.roi.height > 1600) fail("roi is invalid; only bottom overflow is permitted");
        if (isAdaptiveRequest(value)) {
            if (value.presetVersion === "slot-4-development" && value.developmentIdentity !== "slot-4-development") fail("developmentIdentity must explicitly match presetVersion");
            requireString(value.sourceId, "sourceId");
            requireString(value.birefnetMask, "birefnetMask");
            requireString(value.productLayer, "productLayer");
            requireString(value.shadowLayer, "shadowLayer");
            if (!value.sampledPoint || value.whitePoint) fail("v2.4 requires sampledPoint and forbids fixed whitePoint");
            requireInteger(value.sampledPoint.x, "sampledPoint.x"); requireInteger(value.sampledPoint.y, "sampledPoint.y");
            if (value.sampledPoint.x < 0 || value.sampledPoint.x >= 800 || value.sampledPoint.y < 0 || value.sampledPoint.y >= 800) fail("sampledPoint is outside the source canvas");
            if (!value.whiteSamplePolicy || !value.goldStandardIds || !(value.goldStandardIds instanceof Array) || value.goldStandardIds.length < 2) fail("adaptive request requires explicit whiteSamplePolicy and at least two goldStandardIds");
        } else {
            if (!value.whitePoint) fail("historical requests require whitePoint");
            requireInteger(value.whitePoint.x, "whitePoint.x"); requireInteger(value.whitePoint.y, "whitePoint.y");
            if (value.whitePoint.x < 0 || value.whitePoint.x >= 800 || value.whitePoint.y < 0 || value.whitePoint.y >= 800) fail("whitePoint is outside the 800-reference canvas");
        }
        if (!(value.sampledRgb instanceof Array) || value.sampledRgb.length !== 3) fail("sampledRgb must contain the three raw V1 channels");
        for (var channelIndex = 0; channelIndex < 3; channelIndex++) {
            requireInteger(value.sampledRgb[channelIndex], "sampledRgb[" + channelIndex + "]");
            if (value.sampledRgb[channelIndex] < 1 || value.sampledRgb[channelIndex] > 255) fail("sampledRgb channels must be from 1 through 255");
        }
        if (!value.layerNames) fail("layerNames is required");
        requireString(value.layerNames.product, "layerNames.product");
        requireString(value.layerNames.shadow, "layerNames.shadow");
        requireString(value.layerNames.background, "layerNames.background");
    }

    var requestPath = $.getenv("WORKBENCH_SHADOW_CALIBRATION_REQUEST");
    if (!requestPath) fail("WORKBENCH_SHADOW_CALIBRATION_REQUEST is not set");
    var request = readJson(new File(requestPath));
    validateRequest(request);
    var input = new File(request.input);
    var outputDir = new Folder(request.outputDir);
    if (!input.exists) fail("input does not exist");
    if (request.sourceId && input.name.replace(/\.[^.]+$/, "") !== request.sourceId) fail("input filename does not match sourceId");
    if (outputDir.exists) fail("outputDir already exists; refusing to overwrite");
    if (!outputDir.create()) fail("cannot create output directory");

    var source = null;
    var doc = null;
    var preview = null;
    var maskDoc = null;
    try {
    source = app.open(input);
    doc = source.duplicate(input.name.replace(/\.[^.]+$/, "") + "-shadow-calibration", false);
    source.close(SaveOptions.DONOTSAVECHANGES); source = null;
    if (doc.width.as("px") !== doc.height.as("px")) fail("input must be square");
    if (doc.mode !== DocumentMode.RGB) doc.changeMode(ChangeMode.RGB);
    doc.bitsPerChannel = BitsPerChannelType.EIGHT;

    var scale = doc.width.as("px") / 800;
    var sampleX = request.sampledPoint ? request.sampledPoint.x : Math.round(request.whitePoint.x * scale);
    var sampleY = request.sampledPoint ? request.sampledPoint.y : Math.round(request.whitePoint.y * scale);
    var sampler = doc.colorSamplers.add([UnitValue(sampleX, "px"), UnitValue(sampleY, "px")]);
    var color = sampler.color.rgb;
    var photoshopSampledRgb = [
        Math.max(1, Math.min(255, Math.round(color.red))),
        Math.max(1, Math.min(255, Math.round(color.green))),
        Math.max(1, Math.min(255, Math.round(color.blue)))
    ];
    // Photoshop's colour-management display conversion can shift a channel by
    // one even though the decoded PNG byte is unchanged. Native composition
    // works from those source bytes, so both implementations must use the raw
    // V1 per-channel median supplied by the fail-closed adaptive sampler.
    var whiteR = request.sampledRgb[0];
    var whiteG = request.sampledRgb[1];
    var whiteB = request.sampledRgb[2];
    sampler.remove();

    var original = doc.activeLayer;
    if (original.isBackgroundLayer) original.isBackgroundLayer = false;
    var background = doc.artLayers.add();
    background.name = request.layerNames.background;
    background.move(original, ElementPlacement.PLACEAFTER);
    doc.activeLayer = background;
    doc.selection.selectAll();
    var white = new SolidColor(); white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;
    doc.selection.fill(white, ColorBlendMode.NORMAL, 100, false); doc.selection.deselect();

    var shadow, product;
    if (isAdaptiveRequest(request)) {
        shadow = duplicateFileLayerInto(request.shadowLayer, doc, request.layerNames.shadow, background);
        product = original.duplicate(); product.name = request.layerNames.product;
        product.move(shadow, ElementPlacement.PLACEBEFORE); doc.activeLayer = product;
        // The product layer and its exported mask must originate from Photoshop
        // Select Subject, never from the locked BiRefNet matte used by native compositing.
        selectSubject();
        doc.selection.invert(); doc.selection.clear(); doc.selection.deselect();
    } else {
        shadow = original.duplicate(); shadow.name = request.layerNames.shadow;
        shadow.move(background, ElementPlacement.PLACEBEFORE); doc.activeLayer = shadow;
        var left = Math.round(request.roi.x * scale);
        var top = Math.round(request.roi.y * scale);
        var right = Math.round((request.roi.x + request.roi.width) * scale);
        var bottom = Math.round((request.roi.y + request.roi.height) * scale);
        doc.selection.select([[left, top], [right, top], [right, bottom], [left, bottom]], SelectionType.REPLACE, 0, false);
        doc.selection.invert(); doc.selection.clear(); doc.selection.deselect();
        applyLevels(whiteR, whiteG, whiteB);
        product = original.duplicate(); product.name = request.layerNames.product;
        product.move(shadow, ElementPlacement.PLACEBEFORE); doc.activeLayer = product;
        selectSubject(); doc.selection.invert(); doc.selection.clear(); doc.selection.deselect();
    }
    original.remove();

    var psdOptions = new PhotoshopSaveOptions(); psdOptions.layers = true; psdOptions.embedColorProfile = true;
    var psdFile = new File(outputDir.fsName + "/calibration.psd");
    doc.saveAs(psdFile, psdOptions, true, Extension.LOWERCASE);

    preview = doc.duplicate("calibration-preview", true);
    savePng(preview, new File(outputDir.fsName + "/preview.png"));
    preview.close(SaveOptions.DONOTSAVECHANGES); preview = null;

    maskDoc = doc.duplicate("product-mask", false);
    app.activeDocument = maskDoc;
    var maskProduct = maskDoc.artLayers.getByName(request.layerNames.product);
    maskDoc.activeLayer = maskProduct;
    // A second Select Subject pass is intentional: it exports an independent
    // Photoshop mask from the Photoshop-cleaned product layer rather than the
    // BiRefNet input used by native compositing.
    selectSubject();
    var savedSelection = maskDoc.channels.add(); savedSelection.name = "product-selection";
    maskDoc.selection.store(savedSelection); maskDoc.selection.deselect();
    for (var layerIndex = 0; layerIndex < maskDoc.layers.length; layerIndex++) maskDoc.layers[layerIndex].visible = false;
    var blackLayer = maskDoc.artLayers.add(); blackLayer.name = "mask-background";
    maskDoc.selection.selectAll();
    var black = new SolidColor(); black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
    maskDoc.selection.fill(black); maskDoc.selection.deselect();
    var whiteLayer = maskDoc.artLayers.add(); whiteLayer.name = "mask";
    maskDoc.selection.load(savedSelection);
    var whiteMask = new SolidColor(); whiteMask.rgb.red = 255; whiteMask.rgb.green = 255; whiteMask.rgb.blue = 255;
    maskDoc.selection.fill(whiteMask); maskDoc.selection.deselect();
    savedSelection.remove();
    maskDoc.flatten();
    savePng(maskDoc, new File(outputDir.fsName + "/product-mask.png"));
    maskDoc.close(SaveOptions.DONOTSAVECHANGES); maskDoc = null;

    writeJson(new File(outputDir.fsName + "/photoshop-report.json"), {
        schemaVersion: 1,
        releaseState: "awaiting-human-approval",
        approved: false,
        publicationAllowed: false,
        sourceId: request.sourceId || input.name.replace(/\.[^.]+$/, ""),
        input: request.input,
        outputPsd: psdFile.fsName,
        presetVersion: request.presetVersion,
        angleSlot: request.angleSlot,
        humanAngleLabel: request.angleLabel,
        referenceCanvas: { width: 800, height: 800 },
        roi: request.roi,
        sampledPoint: request.sampledPoint || { x: sampleX, y: sampleY },
        sampledPointRgb: request.sampledPointRgb || photoshopSampledRgb,
        sampledRgb: [whiteR, whiteG, whiteB],
        photoshopSampledRgb: photoshopSampledRgb,
        productMaskSource: "photoshop-select-subject-second-pass-on-photoshop-product",
        layerNames: request.layerNames,
        layersTopToBottom: [request.layerNames.product, request.layerNames.shadow, request.layerNames.background]
    });
    doc.close(SaveOptions.DONOTSAVECHANGES); doc = null;
    } catch (error) {
        try { if (maskDoc) maskDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (ignoreMask) {}
        try { if (preview) preview.close(SaveOptions.DONOTSAVECHANGES); } catch (ignorePreview) {}
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (ignoreDoc) {}
        try { if (source) source.close(SaveOptions.DONOTSAVECHANGES); } catch (ignoreSource) {}
        throw error;
    }
}());
